import type { Anchor } from "../anchors/anchor.ts";

/**
 * Event log schema (RFC §7). The NDJSON log is the single source of truth.
 * Every event carries an integer `seq` assigned by the writer under the log
 * lock - globally monotonic across all lifecycle segments and never reset
 * (D-050) - plus an ISO-8601 `at` timestamp.
 */

interface BaseEvent {
  /** Globally monotonic sequence number; the cursor (D-040, D-050). */
  readonly seq: number;
  /** ISO-8601 timestamp. */
  readonly at: string;
}

/** Opens a lifecycle segment; carries the v1 snapshot reference. */
export interface SessionOpenedEvent extends BaseEvent {
  readonly t: "session_opened";
  readonly segment: number;
  readonly artifact: string;
  readonly version: number;
  readonly hash: string;
  readonly path: string;
}

/** A new artifact version (watcher-driven). */
export interface VersionEvent extends BaseEvent {
  readonly t: "version";
  readonly version: number;
  readonly hash: string;
  readonly path: string;
}

/** A located human annotation (browser POST; client-minted id). */
export interface AnnotationEvent extends BaseEvent {
  readonly t: "annotation";
  readonly id: string;
  /** Artifact version the annotation was authored against (server-validated; D-066). */
  readonly version: number;
  readonly target: Anchor;
  readonly note: string;
  /**
   * Images pasted onto this annotation. They belong here rather than on a
   * separate message because the anchor already says which element they are
   * about - a screenshot of "this control, broken" is located feedback.
   */
  readonly images?: readonly PromptImage[];
}

/** An image pasted into the composer, stored under the session's `pasted/` dir. */
export interface PromptImage {
  readonly id: string;
  readonly name: string;
  /** Stored filename under `<session>/pasted/`, e.g. `a1b2.png`. */
  readonly file: string;
}

/** A non-located human message (browser POST; client-minted id). */
export interface PromptEvent extends BaseEvent {
  readonly t: "prompt";
  readonly id: string;
  readonly refs: readonly string[];
  readonly text: string;
  readonly images?: readonly PromptImage[];
}

/** An agent reply posted via `lucid wait --reply`. */
export interface AgentReplyEvent extends BaseEvent {
  readonly t: "agent_reply";
  readonly id: string;
  readonly text: string;
}

/**
 * A human revert decision (RFC §8). Forward-only: it does not rewind the log;
 * it records "restore this target to `targetVersion`, because `why`" as feedback
 * the agent applies by re-authoring the artifact forward. Self-justifying so the
 * record stands without the surrounding conversation.
 */
export interface RevertEvent extends BaseEvent {
  readonly t: "revert";
  readonly id: string;
  /** Anchor of the region to restore (lucidId/fingerprint/domPath). */
  readonly target: Anchor;
  /** Version to restore the region to. */
  readonly targetVersion: number;
  /** Why the human reverted - the encoded choice. */
  readonly why: string;
}

/** A question the agent poses to the human, optionally anchored to an element. */
export interface QuestionEvent extends BaseEvent {
  readonly t: "question";
  readonly id: string;
  readonly text: string;
  /** Optional `data-lucid-id` of the element the question is about. */
  readonly ref?: string;
}

/** The human's answer to a question (browser POST). */
export interface QuestionAnsweredEvent extends BaseEvent {
  readonly t: "question_answered";
  readonly id: string;
  readonly questionId: string;
  readonly text: string;
}

export interface ReviewResolvedEvent extends BaseEvent {
  readonly t: "review_resolved";
}

export interface ReviewReopenedEvent extends BaseEvent {
  readonly t: "review_reopened";
}

export interface SessionSuspendedEvent extends BaseEvent {
  readonly t: "session_suspended";
}

export interface SessionResumedEvent extends BaseEvent {
  readonly t: "session_resumed";
  readonly segment: number;
}

export interface SessionEndedEvent extends BaseEvent {
  readonly t: "session_ended";
}

export type LogEvent =
  | SessionOpenedEvent
  | VersionEvent
  | AnnotationEvent
  | PromptEvent
  | AgentReplyEvent
  | RevertEvent
  | QuestionEvent
  | QuestionAnsweredEvent
  | ReviewResolvedEvent
  | ReviewReopenedEvent
  | SessionSuspendedEvent
  | SessionResumedEvent
  | SessionEndedEvent;

export type LogEventType = LogEvent["t"];

/** Events that carry a client/CLI-minted idempotent id used for dedupe (D-057). */
export type IdentifiedEvent =
  | AnnotationEvent
  | PromptEvent
  | AgentReplyEvent
  | RevertEvent
  | QuestionEvent
  | QuestionAnsweredEvent;

export const hasId = (event: LogEvent): event is IdentifiedEvent =>
  event.t === "annotation" ||
  event.t === "prompt" ||
  event.t === "agent_reply" ||
  event.t === "revert" ||
  event.t === "question" ||
  event.t === "question_answered";

/** Body to append: a LogEvent without the writer-assigned `seq`/`at`. */
export type EventInput =
  | Omit<SessionOpenedEvent, "seq" | "at">
  | Omit<VersionEvent, "seq" | "at">
  | Omit<AnnotationEvent, "seq" | "at">
  | Omit<PromptEvent, "seq" | "at">
  | Omit<AgentReplyEvent, "seq" | "at">
  | Omit<RevertEvent, "seq" | "at">
  | Omit<QuestionEvent, "seq" | "at">
  | Omit<QuestionAnsweredEvent, "seq" | "at">
  | Omit<ReviewResolvedEvent, "seq" | "at">
  | Omit<ReviewReopenedEvent, "seq" | "at">
  | Omit<SessionSuspendedEvent, "seq" | "at">
  | Omit<SessionResumedEvent, "seq" | "at">
  | Omit<SessionEndedEvent, "seq" | "at">;
