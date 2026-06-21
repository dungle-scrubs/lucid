import { parseHTML } from "linkedom";
import type { DomRootLike } from "../anchors/dom.ts";
import { anchorResolves } from "../anchors/dom.ts";
import type { Warning } from "../errors.ts";
import { renderCursor } from "./cursor.ts";
import type { AnnotationRecord, FoldedState, MessageRecord } from "./fold.ts";
import { versionRef } from "./fold.ts";
import { verifySnapshot } from "./version.ts";

export type PayloadStatus = "feedback" | "ended" | "suspended" | "waiting";

export interface PayloadAnnotation {
  readonly id: string;
  readonly version: number;
  readonly resolved: boolean;
  readonly target: AnnotationRecord["target"];
  readonly note: string;
  readonly at: string;
}

export interface PayloadMessage {
  readonly role: "human" | "agent";
  readonly text: string;
  readonly at: string;
}

export interface WaitPayload {
  readonly session: string;
  readonly version: number;
  readonly status: PayloadStatus;
  readonly nextCursor: string;
  readonly reviewResolved: boolean;
  readonly annotations: readonly PayloadAnnotation[];
  readonly messages: readonly PayloadMessage[];
  readonly warnings?: readonly Warning[];
}

const toMessage = (m: MessageRecord): PayloadMessage => ({
  role: m.role,
  text: m.text,
  at: m.at,
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
    });
  }

  const payload: WaitPayload = {
    session: opts.session,
    version: opts.state.version,
    status: opts.status,
    nextCursor: renderCursor(opts.nextSeq),
    reviewResolved: opts.state.reviewResolved,
    annotations,
    messages: opts.messages.map(toMessage),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return payload;
};
