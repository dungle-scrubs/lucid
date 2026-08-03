import type { Anchor } from "../anchors/anchor.ts";
import { WELL_FORMED_ID } from "./request-id.ts";
import type { AgentProgress, QuestionOption } from "../protocol/wire.ts";
import type { ItemAnswer, QuestionItem } from "./question-contract.ts";

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
  /** Harness identity, e.g. "claude-code", "codex". */
  readonly harness: string;
  /** The harness's own conversation/session id (stable across resumes). */
  readonly sessionId?: string;
  /** Working directory the session runs from - resume is cwd-scoped. */
  readonly cwd?: string;
  /** Model the session runs on, when the environment declares it - what the
   *  viewer's inherited (attended) pickers display. */
  readonly model?: string;
  /** Effort/reasoning level the session runs at, same provenance as `model`. */
  readonly effort?: string;
  /** The hub request that caused this turn (plan 07, M1.3): the click's
   *  trace, inherited via LUCID_REQUEST_ID, so an authored event points back
   *  at the request log line that started it. */
  readonly trace?: string;
  /** Who vouches for `sessionId`: `assigned` (Lucid handed the harness its
   *  id), `observed` (the harness announced it on structured stdout), or
   *  `declared` (a human or tool asserted it). Only meaningful WITH a
   *  sessionId - authority over nothing vouches for nothing. */
  readonly sessionIdAuthority?: SessionIdAuthority;
  /** Lucid-owned correlation for one launched process (LUCID_LAUNCH_ID).
   *  Correlation, not identity: it names a launch attempt, never enters
   *  resume argv, and must never be read as a sessionId. */
  readonly launchId?: string;
}

/** The closed authority vocabulary, allowlist-checked on every write path:
 *  an unknown authority is dropped, never coerced into a known one. */
export const SESSION_ID_AUTHORITIES = ["assigned", "declared", "observed"] as const;
export type SessionIdAuthority = (typeof SESSION_ID_AUTHORITIES)[number];

/** True when the string carries a C0 control character or DEL. A code-point
 *  scan rather than a control-char regex (which lint rejects for good reason):
 *  the ONE spelling of "control-free" shared by stamp cleaning here and the
 *  identity validators in `launch/`. */
export const hasControlCharacters = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};

/** Strip control characters (incl. the NUL a naive dedupe key would collide
 *  on) and bound the length. Empty after cleaning = absent. Exported for the
 *  sidecar normalizer, which enforces the same bounds on the same fields. */
export const cleanStampField = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c > 0x1f && c !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
};

/**
 * The ONE attendant normalizer (D18), shared by the CLI's direct-append path
 * and the server's HTTP handlers, so the persistent-log invariant (bounded,
 * control-free strings) cannot depend on which writer was live. Returns
 * undefined when no usable harness identity remains.
 */
export const sanitizeAttendant = (input: unknown): AttendantStamp | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const harness = cleanStampField(o.harness, 64);
  if (!harness) return undefined;
  const sessionId = cleanStampField(o.sessionId, 128);
  const cwd = cleanStampField(o.cwd, 1024);
  const model = cleanStampField(o.model, 128);
  const effort = cleanStampField(o.effort, 32);
  // Stricter than the text fields: a trace is well-formed hex or it is
  // nothing (R4) - no truncation, no cleaning, no keeping.
  const trace = typeof o.trace === "string" && WELL_FORMED_ID.test(o.trace) ? o.trace : undefined;
  // Authority is a closed set, and only a present sessionId can carry it.
  const sessionIdAuthority =
    sessionId && SESSION_ID_AUTHORITIES.includes(o.sessionIdAuthority as SessionIdAuthority)
      ? (o.sessionIdAuthority as SessionIdAuthority)
      : undefined;
  // Same log-injection rule as `trace`: a launch id is well-formed or absent.
  const launchId =
    typeof o.launchId === "string" && WELL_FORMED_ID.test(o.launchId) ? o.launchId : undefined;
  return {
    harness,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(trace ? { trace } : {}),
    ...(sessionIdAuthority ? { sessionIdAuthority } : {}),
    ...(launchId ? { launchId } : {}),
  };
};

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
  /** Which TURN produced this, when the writer knows (D-013). Output closes
   *  the turn that produced it, not whatever window happened to be open.
   *  Absent means the anonymous turn - every pre-turnId log. */
  readonly turnId?: string;
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
  /**
   * The FULL ordered list of spots one note covers, when the human collected
   * several (cmd-click). Present only with two or more entries, and `target`
   * MUST equal `targets[0]`, so a reader that knows only `target` still sees
   * the first spot; a single pick stays in the canonical single form.
   */
  readonly targets?: readonly Anchor[];
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
  /** Which TURN produced this, when the writer knows (D-013). Output closes
   *  the turn that produced it, not whatever window happened to be open.
   *  Absent means the anonymous turn - every pre-turnId log. */
  readonly turnId?: string;
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
  /**
   * Why the turn is stuck on the human (`lucid blocked`): a permission it
   * cannot be granted headlessly, a credential it does not have, an
   * instruction it cannot act on without an answer. Reported so the viewer
   * says what is wrong instead of showing motion that is not happening.
   */
  readonly blocked?: string;
  /**
   * The highest seq the acknowledged batch covered - the cursor the taker had
   * just read (D20). Delivery is a claim about a RANGE, not about the ack's own
   * position: feedback can land between the read and the ack, and a presence-only
   * re-ack (`lucid intent`, `lucid progress`) takes delivery of nothing at all.
   * Absent on those and on pre-D20 logs, which therefore claim no delivery.
   */
  readonly covers?: number;
  /**
   * Which TURN this ack belongs to. Lucid permits two agents on one artifact,
   * and the fold keys working state by this so one turn's output cannot close
   * another's window (D-013). Segment-scoped: an id from an earlier segment
   * means nothing in this one.
   *
   * Optional, and absent is not a gap: an ack without it belongs to the
   * ANONYMOUS turn, which is how every log written before this folds. That is
   * what keeps the change additive rather than a migration.
   */
  readonly turnId?: string;
  /** Which harness session took delivery (D18). */
  readonly attendant?: AttendantStamp;
}

/** Why a turn stopped. A CLOSED set - the viewer owns the wording for each,
 *  so no harness prose rides in on this event (D-005, D-015). */
export type TurnEndReason = "done" | "exited" | "failed" | "usage_limit";

/**
 * A turn stopped (plan 08, RFC-01).
 *
 * A turn's START was always recorded - an ack - but nothing recorded it
 * stopping, so the working window closed only on real output. A turn that read
 * the feedback and correctly decided nothing was needed, or that hit a usage
 * wall, or that died, left the viewer claiming the agent was still responding.
 *
 * Advisory: it changes what the viewer paints and nothing else. It carries no
 * `covers`, moves no delivery cursor, and does not release `wait` (see
 * WAKES_WAIT in fold.ts) - an agent asking for feedback must not be woken
 * because a DIFFERENT agent's turn ended.
 *
 * There is deliberately no free-text field. An earlier draft carried a bounded,
 * control-stripped `detail`; bounding a string is not redaction, and a CLI
 * cannot tell a pattern name from copied harness output. `code` is a closed
 * charset the viewer resolves to wording it owns.
 */
export interface AgentTurnEndedEvent extends BaseEvent {
  readonly t: "agent_turn_ended";
  /** Which turn stopped. Segment-scoped, like every turn id. */
  readonly turnId: string;
  readonly reason: TurnEndReason;
  /** Optional stable identifier the viewer resolves to wording. Never prose. */
  readonly code?: string;
  readonly attendant?: AttendantStamp;
}

/** `code`'s charset. Refused rather than truncated: a value that fails this is
 *  not a shortened identifier, it is something else entirely. */
export const TURN_END_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** The closed reason set, for validating an untrusted writer. */
export const TURN_END_REASONS: ReadonlySet<string> = new Set<TurnEndReason>([
  "done",
  "exited",
  "failed",
  "usage_limit",
]);

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
  /** Which TURN produced this, when the writer knows (D-013). Output closes
   *  the turn that produced it, not whatever window happened to be open.
   *  Absent means the anonymous turn - every pre-turnId log. */
  readonly turnId?: string;
  readonly id: string;
  readonly text: string;
  /** Optional `data-lucid-id` of the element the question is about. */
  readonly ref?: string;
  /** Structured choices, when forwarding a multiple-choice question tool. */
  readonly options?: readonly QuestionOption[];
  /** Whether more than one option may be chosen. */
  readonly multi?: boolean;
  /**
   * The rich grouped form (D12): 1..5 questions with structured choices,
   * normalized through `question-contract.ts`. Additive - `text`/`options`/
   * `multi` above stay the legacy single question and are projected from the
   * group when one is present, so old logs and stampless writers fold
   * unchanged and a consumer that knows nothing about groups still reads a
   * usable question.
   */
  readonly group?: readonly QuestionItem[];
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
  /**
   * Per-question answers to a grouped question (D12), validated against the
   * asking event's `group` by the shared validator. Additive alongside the
   * legacy `text`/`options` above, which stay the single-question answer.
   */
  readonly items?: readonly ItemAnswer[];
  /** A region of the artifact the human pinned as their answer's referent. */
  readonly anchor?: Anchor;
  /**
   * The FULL ordered list of pinned regions, when the human pinned several
   * (shift+cmd-click). Same rule as an annotation's `targets`: present only
   * with two or more entries, and `anchor` MUST equal `anchors[0]`, so a
   * single pin stays in the canonical single form. Decided answers only -
   * skip/unclear discard pins like every other decision field.
   */
  readonly anchors?: readonly Anchor[];
  /** Images the human attached to their answer. */
  readonly images?: readonly PromptImage[];
  /** The human declined to answer (Skip). Clears the question without content;
   *  the agent should proceed without it rather than re-ask. */
  readonly skipped?: boolean;
  /** The human did not understand the question (Re-ask). Clears it unanswered;
   *  the agent owes a clearer, shorter version of the SAME question. `text`, if
   *  present, is what they said was confusing. */
  readonly unclear?: boolean;
}

export interface ReviewResolvedEvent extends BaseEvent {
  readonly t: "review_resolved";
}

export interface ReviewReopenedEvent extends BaseEvent {
  readonly t: "review_reopened";
}

/**
 * The human cleared the review record from the viewer.
 *
 * A boundary, not a deletion: the log keeps every event: the fold simply
 * derives the conversation, annotations, questions and verdicts from what
 * follows the newest one of these. Earlier work stays on disk, readable by
 * anything that reads the log, and the viewer says how much it is holding
 * back rather than emptying silently.
 *
 * Deliberately NOT in `WAKES_WAIT`: clearing the viewer is not feedback, and
 * an agent blocked in `wait` has nothing to act on. It sees the emptied record
 * the next time real feedback wakes it.
 */
export interface RecordClearedEvent extends BaseEvent {
  readonly t: "record_cleared";
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

/**
 * Durable record that a harness-native session was BOUND to this review:
 * which harness, which native id, on whose authority, from which launch.
 *
 * Appended only after `session_opened`, and deliberately inert everywhere
 * else: it wakes no waiter (not in WAKES_WAIT), closes no turn, and is not
 * agent output - provenance is news about the past, not activity. The `id`
 * is derived from (launchId, sessionId) so re-discovering the same binding
 * dedupes in the append lock instead of stuttering the log.
 */
export interface HarnessSessionBoundEvent extends BaseEvent {
  readonly t: "harness_session_bound";
  readonly id: string;
  /** The launch that discovered or assigned the identity - required, so a
   *  binding can always be traced back to one process. */
  readonly launchId: string;
  /** The turn the binding arrived in, when one exists. */
  readonly turnId?: string;
  /** The authoritative stamp: harness + sessionId + sessionIdAuthority are
   *  what make this a binding rather than an incidental mention. */
  readonly attendant: AttendantStamp;
}

/** The idempotency id for a binding: same launch, same native id - same
 *  event, however many times discovery announces it. */
export const bindingEventId = (launchId: string, sessionId: string): string =>
  `hsb:${launchId}:${sessionId}`;

export type LogEvent =
  | SessionOpenedEvent
  | VersionEvent
  | AnnotationEvent
  | ForkEvent
  | PromptEvent
  | AgentReplyEvent
  | AgentAckEvent
  | AgentTurnEndedEvent
  | RevertEvent
  | QuestionEvent
  | QuestionAnsweredEvent
  | ReviewResolvedEvent
  | ReviewReopenedEvent
  | RecordClearedEvent
  | SessionSuspendedEvent
  | SessionResumedEvent
  | SessionEndedEvent
  | HarnessSessionBoundEvent;

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
  "harness_session_bound",
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
