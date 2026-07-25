import type { Anchor } from "../anchors/anchor.ts";
import type { AgentProgress, QuestionOption } from "../protocol/wire.ts";

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

/**
 * Provenance: which harness conversation produced an agent-originated event
 * (D18, artifact-first). The artifact is the durable object; a harness
 * session is an inference source temporarily associated with it - so agent
 * events carry WHO, and the fold derives the artifact's session history from
 * stamps already on the record. Optional everywhere: old logs and stampless
 * writers fold unchanged, and human-authored events never carry one (a human
 * has no harness session).
 */
export interface AttendantStamp {
  /** Harness identity, e.g. "claude_code", "codex". */
  readonly harness: string;
  /** The harness's own conversation/session id (stable across resumes). */
  readonly sessionId?: string;
  /** Working directory the session runs from - resume is cwd-scoped. */
  readonly cwd?: string;
}

/** Opens a lifecycle segment; carries the v1 snapshot reference. */
export interface SessionOpenedEvent extends BaseEvent {
  readonly t: "session_opened";
  readonly segment: number;
  readonly artifact: string;
  readonly version: number;
  readonly hash: string;
  readonly path: string;
  /** The session the artifact was born in / reopened under (D18). */
  readonly attendant?: AttendantStamp;
}

/** A new artifact version (watcher-driven). */
export interface VersionEvent extends BaseEvent {
  readonly t: "version";
  readonly version: number;
  readonly hash: string;
  readonly path: string;
  /** The session whose turn produced this revision, when the writer knows it
   *  (the attend-mode hub does; a dedicated server's watcher may not). */
  readonly attendant?: AttendantStamp;
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

/**
 * A fork request (browser POST; client-minted id). The human selected a region
 * and asked to spin it off into a new artifact + session rather than annotate
 * in place. Carries the same located shape as an annotation - anchor plus a
 * directive `note` ("turn this into an implementation plan") - but is consumed,
 * not folded into the artifact: the attending agent creates and `lucid open`s
 * the new seeded artifact. The one browser-authored event that asks for a new
 * session; Lucid still only records it (D-064), the agent acts on it.
 */
export interface ForkEvent extends BaseEvent {
  readonly t: "fork";
  readonly id: string;
  /** Artifact version the region was selected against (server-validated; D-066). */
  readonly version: number;
  readonly target: Anchor;
  /** The directive: what the new artifact should become. */
  readonly note: string;
  /** When the human authored it (client-minted, ISO-8601); display metadata. */
  readonly authoredAt?: string;
  /** Images pasted onto the fork directive - located context for the new
   *  artifact (e.g. "build this mockup"), same shape as an annotation's. */
  readonly images?: readonly PromptImage[];
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
  /** Which harness session spoke (D18). */
  readonly attendant?: AttendantStamp;
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
  /**
   * Optional fan-out progress, self-reported when the agent farms the revision
   * out to parallel subagents (read-only audits, a workflow). Re-acked as tasks
   * report so `done` climbs. Purely advisory presence, like `intent`: the window
   * still only closes on real output, and a crashed orchestrator goes stale.
   */
  readonly progress?: AgentProgress;
  /** Which harness session took delivery (D18). */
  readonly attendant?: AttendantStamp;
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
  /** Structured choices, when forwarding a multiple-choice question tool. */
  readonly options?: readonly QuestionOption[];
  /** Whether more than one option may be chosen. */
  readonly multi?: boolean;
  /** Which harness session asked (D18). */
  readonly attendant?: AttendantStamp;
}

/** The human's answer to a question (browser POST). */
export interface QuestionAnsweredEvent extends BaseEvent {
  readonly t: "question_answered";
  readonly id: string;
  readonly questionId: string;
  /** Free-text answer, or the "Other" text alongside chosen options. May be
   *  empty when the human answered purely by selecting options. */
  readonly text: string;
  /** Labels of the options the human chose. */
  readonly options?: readonly string[];
  /** A region of the artifact the human pinned as their answer's referent. */
  readonly anchor?: Anchor;
  /** Images the human attached to their answer. */
  readonly images?: readonly PromptImage[];
  /** The human declined to answer (Skip). Clears the question without content;
   *  the agent should proceed without it rather than re-ask. */
  readonly skipped?: boolean;
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
  /** Who resumed it (D18). */
  readonly attendant?: AttendantStamp;
}

export interface SessionEndedEvent extends BaseEvent {
  readonly t: "session_ended";
}

export type LogEvent =
  | SessionOpenedEvent
  | VersionEvent
  | AnnotationEvent
  | ForkEvent
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
  "fork",
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
