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
}

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
  | { readonly kind: "message"; readonly at: string; readonly message: ConversationMessage };

export type { Anchor, PayloadAnnotationLike };
