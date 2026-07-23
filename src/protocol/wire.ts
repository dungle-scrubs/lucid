import type { Anchor } from "../anchors/anchor.ts";
import type { Warning } from "../errors.ts";

/**
 * The wire contract: every JSON shape that crosses a process or origin
 * boundary - the `lucid wait` payload on stdout, and the viewer's
 * `/__lucid/state`, `/__lucid/sessions`, and `/__lucid/diff` responses.
 *
 * Types only, no runtime imports, so BOTH sides load it: server modules
 * implement these shapes, the chrome bundle `import type`s them. Before this
 * module each side hand-mirrored the other and the wire was what actually
 * bound them; now a field added here is a field on both sides, or the
 * compiler objects.
 */

export type PayloadStatus = "feedback" | "ended" | "suspended" | "waiting";

/** Open "agent is working" window (ack received, no output yet). */
export interface AgentWorking {
  readonly since: string;
  readonly intent?: "revise" | "reply";
  /** Self-reported fan-out progress; present iff the agent called `lucid progress`. */
  readonly progress?: AgentProgress;
}

/**
 * Fan-out status the agent self-reports via `lucid progress`. The canonical
 * shape (events.ts and the sanitizer both reference it); the viewer shows
 * counts only when `total` is set. Fields may arrive on separate acks and are
 * merged, so any one can be omitted on a later refine.
 */
export interface AgentProgress {
  /** Human summary, e.g. "auditing 7 screens against the spec". */
  readonly label?: string;
  /** How many subtasks the fan-out spawned. */
  readonly total?: number;
  /** How many have reported back so far. */
  readonly done?: number;
}

/**
 * One pasted image, addressed for both consumers of this payload: the agent
 * reads bytes off disk via `path`, the viewer fetches `/__lucid/asset/<file>`.
 * Dropping either one silently breaks that half.
 */
export interface PayloadImage {
  readonly name: string;
  /** Stored filename under the session's `pasted/` dir, for the viewer's URL. */
  readonly file: string;
  /** Absolute local path to the pasted image, for the agent to read. */
  readonly path: string;
}

export interface PayloadAnnotation {
  readonly id: string;
  readonly version: number;
  readonly resolved: boolean;
  readonly target: Anchor;
  readonly note: string;
  readonly at: string;
  /** When the human wrote it; `at` is when it reached the log. */
  readonly authoredAt?: string;
  /** Images pasted onto the annotation; addressed for both consumers, as on a
   *  message. Drop `file` and the viewer's thumbs 404; drop `path` and the
   *  agent cannot read the bytes. */
  readonly images?: readonly PayloadImage[];
}

/**
 * A fork request the agent is asked to act on: spin the selected region off
 * into a new artifact + session. `resolved` says whether the anchor still
 * attaches to the current version (a stale fork points at a region since
 * edited away). The agent reads the region from `target` and the directive
 * from `note`; it is never folded back into this artifact.
 */
export interface PayloadFork {
  readonly id: string;
  readonly version: number;
  readonly resolved: boolean;
  readonly target: Anchor;
  readonly note: string;
  readonly at: string;
  readonly authoredAt?: string;
  /** Images pasted onto the fork directive; addressed for both consumers like
   *  an annotation's - the agent reads bytes via `path`, the viewer via `file`. */
  readonly images?: readonly PayloadImage[];
}

export interface PayloadMessage {
  readonly role: "human" | "agent";
  readonly text: string;
  readonly at: string;
  readonly images?: readonly PayloadImage[];
}

export interface PayloadRevert {
  readonly target: Anchor;
  readonly targetVersion: number;
  readonly why: string;
  readonly at: string;
}

/**
 * One choice on a structured question, mirroring a harness question tool's
 * option (Claude Code's AskUserQuestion: a short `label` plus an explanatory
 * `description`). The human picks one or more; free text via "Other" still lands
 * in the answer's `answer` field.
 */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface PayloadQuestion {
  readonly id: string;
  readonly text: string;
  readonly ref?: string;
  /** Structured choices, when the agent posed a multiple-choice question. */
  readonly options?: readonly QuestionOption[];
  /** Whether more than one option may be chosen. */
  readonly multi?: boolean;
  readonly answered: boolean;
  /** Free-text answer (or the "Other" text alongside chosen options). */
  readonly answer?: string;
  /** Labels of the options the human chose. */
  readonly answerOptions?: readonly string[];
  /** A region of the artifact the human pinned as the referent of their answer
   *  - the mirror of the agent's `ref`, captured like an annotation's target. */
  readonly answerAnchor?: Anchor;
  /** Images the human attached to their answer. */
  readonly answerImages?: readonly PayloadImage[];
}

export interface WaitPayload {
  readonly session: string;
  readonly version: number;
  readonly status: PayloadStatus;
  readonly nextCursor: string;
  readonly reviewResolved: boolean;
  readonly annotations: readonly PayloadAnnotation[];
  /** Fork requests to act on (spin off a new artifact); omitted when none. */
  readonly forks?: readonly PayloadFork[];
  readonly messages: readonly PayloadMessage[];
  readonly reverts?: readonly PayloadRevert[];
  readonly questions?: readonly PayloadQuestion[];
  readonly warnings?: readonly Warning[];
  /** Open "agent is working" window (ack received, no output yet). */
  readonly agentWorking?: AgentWorking;
}

/** Who last took delivery of feedback (advisory sidecar): display data with
 *  the copy-paste command that resumes their conversation, never executed. */
export interface AttendantRef {
  readonly harness: string;
  readonly at: string;
  readonly resume?: string;
}

/** One session in a project, as `lucid` (bare) and `/__lucid/sessions` report it. */
export interface SessionSummary {
  readonly session: string;
  readonly name: string;
  readonly status: "active" | "suspended" | "ended";
  readonly version: number;
  readonly segment: number;
  readonly annotations: number;
  readonly live: boolean;
  /** Present when live: the session's own viewer, on its own port. */
  readonly viewer?: string;
  /** Present when dormant: the `lucid open` that would revive it. */
  readonly resume?: string;
  readonly lastAttendant?: AttendantRef;
}

export type HunkKind = "added" | "removed" | "changed";

export interface DiffHunk {
  readonly id: string;
  readonly kind: HunkKind;
  /** Short one-line label for the jump menu. */
  readonly label: string;
  /** Anchor identifying the target, for revert reference. */
  readonly anchor: Anchor;
}

/** `/__lucid/diff` response: version diff + merged redline document. */
export interface DiffResult {
  readonly base: number;
  readonly current: number;
  readonly changed: boolean;
  readonly hunks: readonly DiffHunk[];
  /** Current document body with diff markup injected. */
  readonly mergedHtml: string;
}

/**
 * Context-window usage the attending harness self-reports (its statusline
 * posts it; the model cannot read its own usage). Advisory presence, like the
 * attendant record: shown when reported, absent otherwise, so a non-reporting
 * harness simply has no ring.
 */
export interface ContextUsage {
  /** 0..100 fill for the ring; derived from used/total when only those given. */
  readonly pct: number;
  /** Input tokens used, for the tooltip. */
  readonly used?: number;
  /** Context-window size, for the tooltip. */
  readonly total?: number;
  /** When the harness reported it (ISO-8601). */
  readonly at: string;
}

/** `/__lucid/state` response: the full folded payload plus viewer presence. */
export interface StateResponse extends WaitPayload {
  /** Agents currently blocked in `wait` on this session. */
  readonly agentsListening: number;
  readonly lastAttendant?: AttendantRef;
  /** Last-reported context-window usage of the attending harness, if any. */
  readonly contextUsage?: ContextUsage;
}

/** `/__lucid/sessions` response. */
export interface SessionsResponse {
  readonly root: string;
  readonly current: string;
  readonly sessions: readonly SessionSummary[];
}
