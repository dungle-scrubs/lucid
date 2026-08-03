import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import type { DomRootLike } from "../anchors/dom.ts";
import { anchorMatch } from "../anchors/dom.ts";
import type { AnchorMatch } from "../anchors/dom.ts";
import type { Warning } from "../errors.ts";
import type {
  PayloadAnnotation,
  PayloadFork,
  PayloadMessage,
  PayloadQuestion,
  WaitOutcome,
  WaitPayload,
} from "../protocol/wire.ts";
import { summarizeAnswer } from "./question-contract.ts";
import { renderCursor } from "./cursor.ts";
import type {
  AnnotationRecord,
  FoldedState,
  ForkRecord,
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
  PayloadFork,
  PayloadImage,
  PayloadMessage,
  PayloadQuestion,
  PayloadRevert,
  WaitOutcome,
  WaitPayload,
} from "../protocol/wire.ts";

/**
 * Where one piece of human feedback got to (D20): `delivered` once an agent
 * acked a batch whose claimed range included it, `answered` once agent output
 * landed after it. Both derive from log seqs alone, so the panel can never
 * claim a delivery that did not happen - and "does it see it?" is answered
 * without asking. Absent rather than false: the wire stays additive, and an
 * old consumer sees the payload it always saw.
 *
 * `answered` implies `delivered`: output that happens to land after an item
 * nobody took delivery of answered something else, and saying otherwise would
 * be the strongest chip on the weakest evidence.
 */
const deliveryOf = (seq: number, state: FoldedState): { delivered?: true; answered?: true } => {
  const delivered = seq <= state.deliveredThroughSeq;
  return {
    ...(delivered ? { delivered: true as const } : {}),
    ...(delivered && state.lastAgentOutputSeq > seq ? { answered: true as const } : {}),
  };
};

const toMessage = (
  m: MessageRecord,
  assetAbsPath: (file: string) => string,
  state: FoldedState,
): PayloadMessage => ({
  role: m.role,
  ...(m.id ? { id: m.id } : {}),
  text: m.text,
  at: m.at,
  seq: m.seq,
  ...(m.images && m.images.length > 0
    ? {
        images: m.images.map((img) => ({
          name: img.name,
          file: img.file,
          path: assetAbsPath(img.file),
        })),
      }
    : {}),
  // An agent's own turn has nobody to be delivered to.
  ...(m.role === "human" ? deliveryOf(m.seq, state) : {}),
});

/**
 * One question + its answer as the agent reads them. The `answer` line is the
 * ONE readable summary either kind of question produces: a legacy question's
 * free text, or a grouped question's combined summary derived from the stored
 * group and per-item answers (Trevor's `ProviderQuestionAccept.answer`). It is
 * derived here rather than stored on the answer event, so it can never disagree
 * with the group it summarizes.
 */
const toQuestion = (q: QuestionRecord, assetAbsPath: (file: string) => string): PayloadQuestion => {
  const grouped = q.group && q.group.length > 0 && q.items && q.items.length > 0 && !q.skipped;
  const answer = grouped ? summarizeAnswer(q.group ?? [], q.items ?? []) : (q.answer ?? "");
  return {
    id: q.id,
    text: q.text,
    ...(q.ref ? { ref: q.ref } : {}),
    ...(q.options && q.options.length > 0 ? { options: q.options } : {}),
    ...(q.multi ? { multi: true } : {}),
    ...(q.group && q.group.length > 0 ? { group: q.group } : {}),
    at: q.at,
    ...(q.answeredAt ? { answeredAt: q.answeredAt } : {}),
    answered: q.answered,
    ...(q.skipped ? { skipped: true } : {}),
    ...(q.unclear ? { unclear: true } : {}),
    ...(answer.length > 0 ? { answer } : {}),
    ...(q.answerOptions && q.answerOptions.length > 0 ? { answerOptions: q.answerOptions } : {}),
    ...(q.items && q.items.length > 0 ? { answerItems: q.items } : {}),
    ...(q.answerAnchor ? { answerAnchor: q.answerAnchor } : {}),
    ...(q.answerAnchors && q.answerAnchors.length > 0 ? { answerAnchors: q.answerAnchors } : {}),
    ...(q.answerImages && q.answerImages.length > 0
      ? {
          answerImages: q.answerImages.map((img) => ({
            name: img.name,
            file: img.file,
            path: assetAbsPath(img.file),
          })),
        }
      : {}),
  };
};

/** The fields the snapshot guard needs; annotations and forks both satisfy it.
 *  `targets` rides along so a multi-target annotation resolves per spot. */
type ResolvableRecord = Pick<AnnotationRecord, "id" | "version" | "target" | "targets">;

/**
 * Resolve a single located record (annotation or fork) against the current
 * artifact, applying the authored-version snapshot guard (D-023, D-035). A
 * record authored against a now-missing/mismatched snapshot is orphaned and
 * never re-anchored to current.
 *
 * Returns HOW it re-attached, not merely whether (plan 05, M2.1/M2.2): `null`
 * for a miss, `"exact"` when an id or a unique fingerprint named it, and
 * `"positional"` when only the slot lined up. A multi-target record takes the
 * BEST of its spots - one exact hit is enough to stop qualifying the whole
 * note, and the overlay paints nothing for the spots that were edited away.
 */
const resolveAnnotation = async (
  record: ResolvableRecord,
  state: FoldedState,
  currentRoot: DomRootLike,
  snapshotAbsPath: (relPath: string) => string,
  warnings: Warning[],
  /** Noun for diagnostics so a fork's warning does not call it an annotation. */
  noun: "annotation" | "fork" = "annotation",
): Promise<AnchorMatch | null> => {
  // A client-supplied stamp outside [1, current] is never trusted; the
  // record orphans rather than re-pointing at the wrong target (D-066).
  if (!Number.isInteger(record.version) || record.version < 1 || record.version > state.version) {
    warnings.push({
      code: "VERSION_STAMP_INVALID",
      message: `${noun} ${record.id} has out-of-range version ${record.version} (current ${state.version}); orphaned`,
      detail: { id: record.id, version: record.version, current: state.version },
    });
    return null;
  }
  if (record.version < state.version) {
    const ref = versionRef(state, record.version);
    if (!ref) {
      warnings.push({
        code: "SNAPSHOT_MISSING",
        message: `${noun} ${record.id} references unknown version ${record.version}`,
        detail: { id: record.id, version: record.version },
      });
      return null;
    }
    const status = await verifySnapshot(snapshotAbsPath(ref.path), ref.hash);
    if (status !== "ok") {
      warnings.push({
        code: status === "missing" ? "SNAPSHOT_MISSING" : "SNAPSHOT_MISMATCH",
        message: `authored snapshot for v${record.version} is ${status}; ${noun} ${record.id} orphaned`,
        detail: { id: record.id, version: record.version, path: ref.path },
      });
      return null;
    }
  }
  // Carry forward: does the anchor still attach to the current version? A
  // multi-target record stays live while ANY spot survives - the overlay
  // simply paints no mark for the spots that were edited away.
  // Short-circuits on the first EXACT hit, like the `.some(...)` predicate
  // this replaced. Mapping every target instead cost a full
  // `querySelectorAll("*")` + fingerprint pass per missing target on this hot
  // path (`/__lucid/state`, which the viewer polls, and every `lucid wait`) -
  // measured 5.5x on a 6-target annotation over an 8k-element document, which
  // is the same shape #46 was hardened against.
  let best: AnchorMatch | null = null;
  for (const t of record.targets ?? [record.target]) {
    const match = anchorMatch(t, currentRoot);
    if (match === "exact") return "exact";
    if (match === "positional") best = "positional";
  }
  return best;
};

/** The wire's qualifier for a resolution: only a positional-only hit earns one. */
const confidenceOf = (match: AnchorMatch | null): { confidence?: "low" } =>
  match === "positional" ? { confidence: "low" } : {};

export interface BuildPayloadOptions {
  readonly session: string;
  readonly state: FoldedState;
  readonly status: WaitOutcome;
  /** Current artifact HTML (for anchor carry-forward). */
  readonly currentHtml: string;
  /** Map a snapshot relative path (e.g. `versions/s1/v2.html`) to an abs path. */
  readonly snapshotAbsPath: (relPath: string) => string;
  /** Annotations to include (full set or delta). */
  readonly annotations: readonly AnnotationRecord[];
  /** Fork requests to include (full set or delta). */
  readonly forks?: readonly ForkRecord[];
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
      resolved: resolved !== null,
      ...confidenceOf(resolved),
      target: a.target,
      ...(a.targets && a.targets.length > 0 ? { targets: a.targets } : {}),
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
      ...deliveryOf(a.seq, opts.state),
    });
  }

  const forks: PayloadFork[] = [];
  for (const f of opts.forks ?? []) {
    const resolved = await resolveAnnotation(
      f,
      opts.state,
      root,
      opts.snapshotAbsPath,
      warnings,
      "fork",
    );
    forks.push({
      id: f.id,
      version: f.version,
      resolved: resolved !== null,
      ...confidenceOf(resolved),
      target: f.target,
      note: f.note,
      at: f.at,
      ...(f.authoredAt ? { authoredAt: f.authoredAt } : {}),
      ...(f.images && f.images.length > 0
        ? {
            images: f.images.map((img) => ({
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
    ...(opts.state.verdicts.length > 0 ? { verdicts: opts.state.verdicts } : {}),
    ...(opts.state.cleared ? { cleared: opts.state.cleared } : {}),
    ...(opts.state.agentWorking ? { agentWorking: opts.state.agentWorking } : {}),
    ...(opts.state.lastTurnEnd ? { lastTurnEnd: opts.state.lastTurnEnd } : {}),
    ...(opts.state.sessionHistory.length > 0 ? { sessionHistory: opts.state.sessionHistory } : {}),
    annotations,
    ...(forks.length > 0 ? { forks } : {}),
    messages: opts.messages.map((m) =>
      toMessage(m, (file) => opts.snapshotAbsPath(pastedRelPath(file)), opts.state),
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
          questions: opts.questions.map((q) =>
            toQuestion(q, (file) => opts.snapshotAbsPath(pastedRelPath(file))),
          ),
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return payload;
};

/** The record slices a payload carries (full folded sets or since-cursor deltas). */
export interface PayloadSlices {
  readonly annotations: readonly AnnotationRecord[];
  readonly forks?: readonly ForkRecord[];
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
  status: WaitOutcome,
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
    forks: slices.forks ?? state.forks,
    messages: slices.messages,
    reverts: slices.reverts ?? [],
    questions: slices.questions ?? state.questions,
    nextSeq: state.highSeq,
    ...(extraWarnings && extraWarnings.length > 0 ? { extraWarnings } : {}),
  });
};
