import type { Anchor } from "../../src/anchors/anchor.ts";
import type {
  DiffHunk,
  DiffResult,
  PayloadImage,
  PayloadMessage,
  PayloadQuestion,
  SessionSummary,
} from "../../src/protocol/wire.ts";
import type { PayloadAnnotationLike } from "../shared/protocol.ts";

export interface Config {
  readonly mode: string;
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
  /** URL prefix of this session's routes ("" on a dedicated server,
   *  "/s/<id>" under the daemon). Older servers omit it; treat as "". */
  readonly base?: string;
  /** Cap on the fatal-stream reconnect backoff, ms (D-069). Declared here so
   *  the field is type-connected end to end: it survived as an untyped extra
   *  key on the runtime spread, which meant a rename on the server would keep
   *  typecheck green while the cap silently stopped arriving - the M3.4
   *  `reducedMotion` failure exactly. */
  readonly sseMaxBackoffMs?: number;
}

/**
 * What the SHELL page carries, as one declaration both sides import.
 *
 * The shell's payload is written by `src/server/daemon.ts` into a template
 * string and read back by `client/chrome/hub.ts`; without a shared type those
 * two spellings drift silently, which is the same failure this interface's
 * sibling field above exists to prevent.
 */
export interface ShellConfig {
  readonly mode: "shell";
  readonly sseMaxBackoffMs?: number;
  /** Connected-stream cap override (LUCID_STREAM_CAP) - a test seam: the
   *  eviction behavior is only exercisable without opening 11 real tabs. */
  readonly streamCap?: number;
}

/**
 * Where a piece of sent feedback got to (D20), strongest known state last:
 * `recorded` (in the log, nothing has taken it yet) -> `delivered` (an agent
 * acked the batch it was in) -> `answered` (agent output followed it).
 */
export type DeliveryState = "recorded" | "delivered" | "answered";

/** An image on a message already in the log. The thumb and lightbox address it
 *  as `/__lucid/asset/<file>` via its `file` field. */
export type MessageImage = PayloadImage;

/** A message as the wire delivers it (src/protocol/wire.ts). */
export type ConversationMessage = PayloadMessage;

/** A pasted image staged in the composer (not yet sent). */
export interface PastedImage {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  /** Local object URL for the composer thumbnail. */
  readonly url: string;
}

export interface QueuedAnnotation {
  readonly id: string;
  readonly target: Anchor;
  /** Every spot the note covers, in pick order; `target` is always the first.
   *  A singleton for the ordinary single-click annotation. */
  readonly targets: readonly Anchor[];
  readonly note: string;
  /** When the note was queued - its place in the record. */
  readonly at: string;
  /** Staged images travel with the queued item, so an edit or a reorder never
   *  separates a screenshot from the note it belongs to. */
  readonly images: readonly PastedImage[];
}

export interface WarningItem {
  /** Stable per occurrence: the same warning can legitimately fire twice (two
   *  failed sends), and keying the list by text alone collapsed them into one
   *  React key. */
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

/** An image already uploaded to the session's store, as the wire takes it. */
export interface OutboxImage {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

/**
 * A message the human submitted that is not in the log yet.
 *
 * assistant-ui empties the composer before it hands the message over, so by the
 * time anything can fail the human's typing exists nowhere else. The outbox is
 * that "nowhere else": written (and persisted) before the network is touched,
 * cleared only once the server has the message. `text` is post-expansion - the
 * paste map is tab-local, so a placeholder would not survive a reload.
 */
export interface OutboxMessage {
  readonly id: string;
  readonly text: string;
  readonly images: readonly OutboxImage[];
  readonly at: string;
  /** An attempt has failed. Until then the entry is invisible: an in-flight
   *  message is about to become a real one, and flashing a card for it would
   *  make every normal send stutter. */
  readonly failed: boolean;
}

/** One sibling session in this project, as `/__lucid/sessions` reports it -
 *  the wire type itself (src/protocol/wire.ts), so the two sides cannot drift. */
export type { DiffHunk, SessionSummary };

/** An agent question as the wire delivers it (src/protocol/wire.ts). */
export type AgentQuestion = PayloadQuestion;

/** The `/__lucid/diff` response as the wire delivers it (src/protocol/wire.ts). */
export type DiffData = DiffResult;

/**
 * One entry in the review record.
 *
 * assistant-ui has no notion of a thread item that is not a message, and the
 * transcript renders in array order (not by `createdAt`). Lucid's log is
 * already chronological, so mapping it 1:1 into this array is what keeps a sent
 * annotation sitting where it happened rather than jumping above the replies
 * that preceded it.
 */
export type TimelineItem =
  | {
      readonly kind: "annotation";
      readonly at: string;
      /** 1-based number matching the annotation's badge on the surface, or
       *  null when the anchor is orphaned - there is no mark left to match. */
      readonly index: number | null;
      readonly annotation: PayloadAnnotationLike;
    }
  | {
      /** Composed but unsent: client-side state holding its place in the
       *  record at the moment it was written, exactly where the same card
       *  lands once sent (the event carries authoredAt). */
      readonly kind: "queued";
      readonly at: string;
      readonly index: number;
      readonly id: string;
    }
  | {
      /** An ANSWERED question and its answer, as one item at the moment the
       *  human settled it (D14). Unanswered questions are not in the record. */
      readonly kind: "question";
      readonly at: string;
      readonly question: AgentQuestion;
    }
  | {
      /** The review being approved or reopened, at the moment it happened.
       *  A verdict is an event in the record, not a status: collapsing it to a
       *  boolean left an approval with no trace anywhere in the transcript and
       *  a reopening pinned below messages that came after it. */
      readonly kind: "verdict";
      readonly at: string;
      readonly verdict: ReviewVerdict;
    }
  | {
      /** The boundary a `/clear` left behind, at the moment it happened. It is
       *  the first entry in a cleared record, and the only thing saying the
       *  earlier work still exists. */
      readonly kind: "cleared";
      readonly at: string;
      readonly cleared: RecordCleared;
    }
  | { readonly kind: "message"; readonly at: string; readonly message: ConversationMessage };

/** The newest clear boundary: when it happened and how much it hid. */
export interface RecordCleared {
  readonly at: string;
  readonly hiddenCount: number;
  readonly seq: number;
}

/** One `review_resolved`/`review_reopened` event, kept with its own time so it
 *  can sit in the record where it belongs. `seq` is the log's own ordering and
 *  is what makes the id stable across reloads. */
export interface ReviewVerdict {
  readonly at: string;
  /** True for `review_resolved` (approved), false for `review_reopened`. */
  readonly resolved: boolean;
  readonly seq: number;
}

export type { Anchor, PayloadAnnotationLike };
