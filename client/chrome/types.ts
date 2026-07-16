import type { Anchor } from "../../src/anchors/anchor.ts";
import type { PayloadAnnotationLike } from "../shared/protocol.ts";

export interface Config {
  readonly mode: string;
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
}

/** An image on a message already in the log. The thumb and lightbox address it
 *  as `/__lucid/asset/<file>`, so `file` is the field that must survive the
 *  round trip through the wait payload. */
export interface MessageImage {
  readonly name: string;
  readonly file: string;
}

export interface ConversationMessage {
  readonly role: "human" | "agent";
  readonly text: string;
  readonly at: string;
  readonly images?: readonly MessageImage[];
}

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
  readonly code: string;
  readonly message: string;
}

/**
 * One sibling session in this project, as `/__lucid/sessions` reports it.
 * Mirrors `SessionSummary` in src/core/sessions.ts - the chrome cannot import
 * server types across the bundle boundary, so this is a hand-mirror, and the
 * wire contract is what actually binds them.
 */
export interface SessionSummary {
  readonly session: string;
  readonly name: string;
  readonly status: "active" | "suspended" | "ended";
  readonly version: number;
  readonly segment: number;
  readonly annotations: number;
  readonly live: boolean;
  /** Present when live: the other session's own viewer, on its own port. */
  readonly viewer?: string;
  /** Present when dormant: the `lucid open` that would revive it. */
  readonly resume?: string;
  /** Who last attended it, and how to get that conversation back. */
  readonly lastAttendant?: {
    readonly harness: string;
    readonly at: string;
    readonly resume?: string;
  };
}

export interface AgentQuestion {
  readonly id: string;
  readonly text: string;
  readonly ref?: string;
  readonly answered: boolean;
  readonly answer?: string;
}

export interface DiffHunk {
  readonly id: string;
  readonly kind: "added" | "removed" | "changed";
  readonly label: string;
  readonly anchor: Anchor;
}

export interface DiffData {
  readonly base: number;
  readonly current: number;
  readonly changed: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly mergedHtml: string;
}

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
      /** 1-based number matching the annotation's badge on the surface. */
      readonly index: number;
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
