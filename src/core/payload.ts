import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import type { DomRootLike } from "../anchors/dom.ts";
import { anchorResolves } from "../anchors/dom.ts";
import type { Warning } from "../errors.ts";
import type {
  PayloadAnnotation,
  PayloadMessage,
  PayloadStatus,
  WaitPayload,
} from "../protocol/wire.ts";
import { renderCursor } from "./cursor.ts";
import type {
  AnnotationRecord,
  FoldedState,
  MessageRecord,
  QuestionRecord,
  RevertRecord,
} from "./fold.ts";
import { versionRef } from "./fold.ts";
import { pastedRelPath, type SessionPaths } from "./paths.ts";
import { verifySnapshot } from "./version.ts";

// The payload shapes are the wire contract (src/protocol/wire.ts); re-exported
// here so server-side callers keep importing them from the module that builds them.
export type {
  PayloadAnnotation,
  PayloadImage,
  PayloadMessage,
  PayloadQuestion,
  PayloadRevert,
  PayloadStatus,
  WaitPayload,
} from "../protocol/wire.ts";

const toMessage = (m: MessageRecord, assetAbsPath: (file: string) => string): PayloadMessage => ({
  role: m.role,
  text: m.text,
  at: m.at,
  ...(m.images && m.images.length > 0
    ? {
        images: m.images.map((img) => ({
          name: img.name,
          file: img.file,
          path: assetAbsPath(img.file),
        })),
      }
    : {}),
});

/**
 * Resolve a single annotation against the current artifact, applying the
 * authored-version snapshot guard (D-023, D-035). An annotation authored
 * against a now-missing/mismatched snapshot is orphaned and never re-anchored
 * to current.
 */
const resolveAnnotation = async (
  annotation: AnnotationRecord,
  state: FoldedState,
  currentRoot: DomRootLike,
  snapshotAbsPath: (relPath: string) => string,
  warnings: Warning[],
): Promise<boolean> => {
  // A client-supplied stamp outside [1, current] is never trusted; the
  // annotation orphans rather than re-pointing at the wrong target (D-066).
  if (
    !Number.isInteger(annotation.version) ||
    annotation.version < 1 ||
    annotation.version > state.version
  ) {
    warnings.push({
      code: "VERSION_STAMP_INVALID",
      message: `annotation ${annotation.id} has out-of-range version ${annotation.version} (current ${state.version}); orphaned`,
      detail: { id: annotation.id, version: annotation.version, current: state.version },
    });
    return false;
  }
  if (annotation.version < state.version) {
    const ref = versionRef(state, annotation.version);
    if (!ref) {
      warnings.push({
        code: "SNAPSHOT_MISSING",
        message: `annotation ${annotation.id} references unknown version ${annotation.version}`,
        detail: { id: annotation.id, version: annotation.version },
      });
      return false;
    }
    const status = await verifySnapshot(snapshotAbsPath(ref.path), ref.hash);
    if (status !== "ok") {
      warnings.push({
        code: status === "missing" ? "SNAPSHOT_MISSING" : "SNAPSHOT_MISMATCH",
        message: `authored snapshot for v${annotation.version} is ${status}; annotation ${annotation.id} orphaned`,
        detail: { id: annotation.id, version: annotation.version, path: ref.path },
      });
      return false;
    }
  }
  // Carry forward: does the anchor still attach to the current version?
  return anchorResolves(annotation.target, currentRoot);
};

export interface BuildPayloadOptions {
  readonly session: string;
  readonly state: FoldedState;
  readonly status: PayloadStatus;
  /** Current artifact HTML (for anchor carry-forward). */
  readonly currentHtml: string;
  /** Map a snapshot relative path (e.g. `versions/s1/v2.html`) to an abs path. */
  readonly snapshotAbsPath: (relPath: string) => string;
  /** Annotations to include (full set or delta). */
  readonly annotations: readonly AnnotationRecord[];
  /** Messages to include (full set or delta). */
  readonly messages: readonly MessageRecord[];
  /** Revert decisions to include (full set or delta). */
  readonly reverts?: readonly RevertRecord[];
  /** Questions/answers to include (full set or delta). */
  readonly questions?: readonly QuestionRecord[];
  /** Cursor floor: the seq to render as nextCursor. */
  readonly nextSeq: number;
  readonly extraWarnings?: readonly Warning[];
}

/** Build the wait payload, resolving each included annotation's anchor. */
export const buildWaitPayload = async (opts: BuildPayloadOptions): Promise<WaitPayload> => {
  const warnings: Warning[] = [...(opts.extraWarnings ?? [])];
  const { document } = parseHTML(
    opts.currentHtml.includes("<body") || opts.currentHtml.includes("<html")
      ? opts.currentHtml
      : `<body>${opts.currentHtml}</body>`,
  );
  const root = document as unknown as DomRootLike;

  const annotations: PayloadAnnotation[] = [];
  for (const a of opts.annotations) {
    const resolved = await resolveAnnotation(a, opts.state, root, opts.snapshotAbsPath, warnings);
    annotations.push({
      id: a.id,
      version: a.version,
      resolved,
      target: a.target,
      note: a.note,
      at: a.at,
      ...(a.authoredAt ? { authoredAt: a.authoredAt } : {}),
      ...(a.images && a.images.length > 0
        ? {
            images: a.images.map((img) => ({
              name: img.name,
              file: img.file,
              path: opts.snapshotAbsPath(pastedRelPath(img.file)),
            })),
          }
        : {}),
    });
  }

  const payload: WaitPayload = {
    session: opts.session,
    version: opts.state.version,
    status: opts.status,
    nextCursor: renderCursor(opts.nextSeq),
    reviewResolved: opts.state.reviewResolved,
    ...(opts.state.agentWorking ? { agentWorking: opts.state.agentWorking } : {}),
    annotations,
    messages: opts.messages.map((m) =>
      toMessage(m, (file) => opts.snapshotAbsPath(pastedRelPath(file))),
    ),
    ...(opts.reverts && opts.reverts.length > 0
      ? {
          reverts: opts.reverts.map((r) => ({
            target: r.target,
            targetVersion: r.targetVersion,
            why: r.why,
            at: r.at,
          })),
        }
      : {}),
    ...(opts.questions && opts.questions.length > 0
      ? {
          questions: opts.questions.map((q) => ({
            id: q.id,
            text: q.text,
            ...(q.ref ? { ref: q.ref } : {}),
            answered: q.answered,
            ...(q.answer !== undefined ? { answer: q.answer } : {}),
          })),
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return payload;
};

/** The record slices a payload carries (full folded sets or since-cursor deltas). */
export interface PayloadSlices {
  readonly annotations: readonly AnnotationRecord[];
  readonly messages: readonly MessageRecord[];
  readonly reverts?: readonly RevertRecord[];
  /** Defaults to the segment's full question set. */
  readonly questions?: readonly QuestionRecord[];
}

/**
 * Assemble a payload for a session on disk: read the served copy, resolve
 * snapshot/pasted paths against the session dir, and cursor at the fold's high
 * seq. The one assembly protocol behind BOTH consumer surfaces - `lucid wait`
 * (CLI agents) and `/__lucid/state` (the viewer) - so they cannot drift on how
 * anchors carry forward or images are pathed.
 */
export const assemblePayload = async (
  paths: SessionPaths,
  state: FoldedState,
  status: PayloadStatus,
  slices: PayloadSlices,
  extraWarnings?: readonly Warning[],
): Promise<WaitPayload> => {
  const currentHtml = await readFile(paths.currentHtml, "utf8").catch(() => "");
  return buildWaitPayload({
    session: paths.artifactPath,
    state,
    status,
    currentHtml,
    snapshotAbsPath: (rel) => join(paths.sessionDir, rel),
    annotations: slices.annotations,
    messages: slices.messages,
    reverts: slices.reverts ?? [],
    questions: slices.questions ?? state.questions,
    nextSeq: state.highSeq,
    ...(extraWarnings && extraWarnings.length > 0 ? { extraWarnings } : {}),
  });
};
