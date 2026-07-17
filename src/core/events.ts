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
   * When the human wrote the note (client-minted, ISO-8601). `at` is when the
   * writer appended it - send time. An annotation can sit queued while the
   * conversation moves on, so display order follows authorship, not the send;
   * `seq` stays the only ordering agents rely on.
   */
  readonly authoredAt?: string;
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
 * The agent took delivery of feedback (appended by the CLI at the moment
 * `wait` returns a `feedback` payload). Presence metadata for the viewer: it
 * opens the "agent is working" window, which any agent output (a version, a
 * reply, a question) closes. Never treated as feedback, and `wait` ignores
 * ack-only deltas - agents do not wake each other by acknowledging.
 */
export interface AgentAckEvent extends BaseEvent {
  readonly t: "agent_ack";
  readonly id: string;
  /**
   * Optional declared intent, re-acked by the agent once it has read the
   * feedback and decided what kind of output is coming: "revise" (the
   * artifact will change - the surface shows an update-on-the-way spinner)
   * or "reply" (a conversation message). A promise, not a fact - the window
   * still only closes on real output.
   */
  readonly intent?: "revise" | "reply";
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
  | AgentAckEvent
  | RevertEvent
  | QuestionEvent
  | QuestionAnsweredEvent
  | ReviewResolvedEvent
  | ReviewReopenedEvent
  | SessionSuspendedEvent
  | SessionResumedEvent
  | SessionEndedEvent;

export type LogEventType = LogEvent["t"];

/** The one list of event types that carry a client/CLI-minted idempotent id
 *  used for dedupe (D-057). `IdentifiedEvent` and `hasId` both derive from it,
 *  so a new identified event is added in exactly one place. */
const IDENTIFIED_TYPES = [
  "annotation",
  "prompt",
  "agent_reply",
  "agent_ack",
  "revert",
  "question",
  "question_answered",
] as const satisfies readonly LogEventType[];

/** Events that carry a client/CLI-minted idempotent id used for dedupe (D-057). */
export type IdentifiedEvent = Extract<LogEvent, { t: (typeof IDENTIFIED_TYPES)[number] }>;

const IDENTIFIED = new Set<string>(IDENTIFIED_TYPES);

export const hasId = (event: LogEvent): event is IdentifiedEvent => IDENTIFIED.has(event.t);

/** Body to append: a LogEvent without the writer-assigned `seq`/`at`.
 *  Distributes over the union, so a new event type is covered automatically. */
export type EventInput = {
  [K in LogEventType]: Omit<Extract<LogEvent, { t: K }>, "seq" | "at">;
}[LogEventType];
