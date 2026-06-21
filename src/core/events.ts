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
}

/** A non-located human message (browser POST; client-minted id). */
export interface PromptEvent extends BaseEvent {
  readonly t: "prompt";
  readonly id: string;
  readonly refs: readonly string[];
  readonly text: string;
}

/** An agent reply posted via `lucid wait --reply`. */
export interface AgentReplyEvent extends BaseEvent {
  readonly t: "agent_reply";
  readonly id: string;
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
  | ReviewResolvedEvent
  | ReviewReopenedEvent
  | SessionSuspendedEvent
  | SessionResumedEvent
  | SessionEndedEvent;

export type LogEventType = LogEvent["t"];

/** Events that carry a client/CLI-minted idempotent id used for dedupe (D-057). */
export type IdentifiedEvent = AnnotationEvent | PromptEvent | AgentReplyEvent;

export const hasId = (event: LogEvent): event is IdentifiedEvent =>
  event.t === "annotation" || event.t === "prompt" || event.t === "agent_reply";

/** Body to append: a LogEvent without the writer-assigned `seq`/`at`. */
export type EventInput =
  | Omit<SessionOpenedEvent, "seq" | "at">
  | Omit<VersionEvent, "seq" | "at">
  | Omit<AnnotationEvent, "seq" | "at">
  | Omit<PromptEvent, "seq" | "at">
  | Omit<AgentReplyEvent, "seq" | "at">
  | Omit<ReviewResolvedEvent, "seq" | "at">
  | Omit<ReviewReopenedEvent, "seq" | "at">
  | Omit<SessionSuspendedEvent, "seq" | "at">
  | Omit<SessionResumedEvent, "seq" | "at">
  | Omit<SessionEndedEvent, "seq" | "at">;
