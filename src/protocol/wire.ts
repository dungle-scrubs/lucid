import type { Anchor } from "../anchors/anchor.ts";
import type { Warning } from "../errors.ts";
import type { ItemAnswer, QuestionItem } from "../core/question-contract.ts";

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
  /** The last time this turn said ANYTHING - its most recent ack. `since` is
   *  when delivery happened and never moves, so it cannot answer "is this
   *  still alive?": a turn narrating its phases for half an hour and a turn
   *  that died two minutes in look identical by that clock. Optional: a server
   *  older than this field simply reports nothing, and readers fall back to
   *  `since`. */
  readonly heardAt?: string;
  readonly intent?: "revise" | "reply";
  /** Self-reported fan-out progress; present iff the agent called `lucid progress`. */
  readonly progress?: AgentProgress;
  /**
   * Why this turn cannot continue without the human, self-reported by
   * `lucid blocked`. A headless turn has no terminal anyone is reading, so a
   * question it asks there reaches nobody: it stops, and the viewer shows a
   * spinner over work that will never resume. This is the sentence that
   * replaces the spinner. Cleared by the agent's next ordinary ack, because
   * moving again IS the unblocking.
   */
  readonly blocked?: string;
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
  /**
   * Every spot the note covers, when the human collected several with one
   * draft (additive). `target` is always `targets[0]`, so a consumer that
   * knows only `target` reads the first spot; `resolved` is true while ANY
   * of them still attaches. Omitted for the single-target annotation.
   */
  readonly targets?: readonly Anchor[];
  /**
   * Present, and always `"low"`, when the anchor re-attached ONLY by position
   * (plan 05, M2.2, finding #47): no `data-lucid-id` and no unique fingerprint
   * matched, so this is whatever element or offset now occupies that slot
   * rather than the thing the human pointed at. Absent means the match was
   * exact - so an older reader, which knows nothing of this field, keeps
   * reading `resolved` exactly as before.
   *
   * A miss is still `resolved: false`. This field never softens a failure into
   * a maybe; it qualifies a success that is a guess.
   */
  readonly confidence?: "low";
  readonly note: string;
  readonly at: string;
  /** When the human wrote it; `at` is when it reached the log. */
  readonly authoredAt?: string;
  /** Images pasted onto the annotation; addressed for both consumers, as on a
   *  message. Drop `file` and the viewer's thumbs 404; drop `path` and the
   *  agent cannot read the bytes. */
  readonly images?: readonly PayloadImage[];
  /** An agent acked delivery of a batch this item was in (D20). */
  readonly delivered?: true;
  /** Agent output - a new version, reply, or question - landed after this
   *  item (D20). */
  readonly answered?: true;
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
  /** As on an annotation: present and `"low"` when the fork's region
   *  re-attached only by position (plan 05, M2.2, #47). */
  readonly confidence?: "low";
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
  /** The client-minted id a human message was sent under, when the log has one.
   *  The composer holds the ids of a send it is waiting on and clears them as
   *  the payload reports them delivered; without this the message path could
   *  not tell WHICH send a payload confirmed and would wait forever. Additive
   *  and human-only: agent messages have no client id. */
  readonly id?: string;
  /** The message's own event seq - unique per append, where `at` is not: one
   *  ISO timestamp is stamped per APPEND at millisecond precision, so two
   *  messages written in the same millisecond share it. A viewer keying a
   *  message by `role`+`at` therefore mints duplicate ids, and a duplicate id
   *  makes assistant-ui's MessageRepository throw and unmount the whole
   *  review surface (measured: 24 posts -> 6 collisions -> blank page). */
  readonly seq: number;
  readonly images?: readonly PayloadImage[];
  /** Human turns only: an agent acked delivery of a batch this message was
   *  in (D20). An agent's own turn is never "delivered" to anyone. */
  readonly delivered?: true;
  /** Human turns only: agent output landed after this message (D20). */
  readonly answered?: true;
}

/**
 * One approve or reopen, with the moment it happened.
 *
 * The `reviewResolved` flag beside it is the CURRENT verdict and carries no
 * time, so a viewer holding only that can say the review is approved but never
 * where in the conversation it was approved - and a reopening ends up pinned
 * below messages that came after it.
 */
export interface PayloadVerdict {
  readonly at: string;
  /** True for an approval, false for a reopening. */
  readonly resolved: boolean;
  readonly seq: number;
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
  /**
   * The rich grouped question (D12), when the agent asked one. Additive: the
   * legacy `text`/`options`/`multi` above are projected from it, so a consumer
   * that ignores this field still reads a usable question.
   */
  readonly group?: readonly QuestionItem[];
  /** When the agent asked. */
  readonly at?: string;
  /** When the human answered (absent while outstanding). The transcript folds
   *  question and answer into ONE item positioned here, not at `at` (D14). */
  readonly answeredAt?: string;
  readonly answered: boolean;
  /** The human declined to answer (Skip): `answered` is true but there is no
   *  content - proceed without it rather than re-asking. */
  readonly skipped?: boolean;
  /** The human did not understand the question (Re-ask): `answered` is true but
   *  nothing was decided - ask the SAME question again, shorter and clearer.
   *  `answer`, when present, is what they said was confusing. */
  readonly unclear?: boolean;
  /**
   * The answer as one readable line. For a legacy question this is the human's
   * free text (or the "Other" text alongside chosen options); for a grouped
   * question it is the COMBINED SUMMARY derived from `answerItems` - what an
   * agent reads without walking the structure.
   */
  readonly answer?: string;
  /** Labels of the options the human chose. */
  readonly answerOptions?: readonly string[];
  /** Per-question answers to a grouped question (D12), one per `group` item. */
  readonly answerItems?: readonly ItemAnswer[];
  /** A region of the artifact the human pinned as the referent of their answer
   *  - the mirror of the agent's `ref`, captured like an annotation's target. */
  readonly answerAnchor?: Anchor;
  /** Every pinned region, when the human pinned several (additive).
   *  `answerAnchor` is always `answerAnchors[0]`; omitted for a single pin. */
  readonly answerAnchors?: readonly Anchor[];
  /** Images the human attached to their answer. */
  readonly answerImages?: readonly PayloadImage[];
}

export interface WaitPayload {
  readonly session: string;
  readonly version: number;
  readonly status: PayloadStatus;
  readonly nextCursor: string;
  readonly reviewResolved: boolean;
  /** Every approve/reopen in this segment, each with its own moment, so the
   *  viewer can place them in the record instead of showing only the latest
   *  state. Omitted when the review has never been settled. */
  readonly verdicts?: readonly PayloadVerdict[];
  readonly annotations: readonly PayloadAnnotation[];
  /** Fork requests to act on (spin off a new artifact); omitted when none. */
  readonly forks?: readonly PayloadFork[];
  readonly messages: readonly PayloadMessage[];
  readonly reverts?: readonly PayloadRevert[];
  readonly questions?: readonly PayloadQuestion[];
  readonly warnings?: readonly Warning[];
  /** Open "agent is working" window (ack received, no output yet). */
  readonly agentWorking?: AgentWorking;
  /** The last turn to end producing nothing, when that is the newest thing to
   *  say. Closing a window silently loses the outcome: feedback marked
   *  delivered with no idea what came of it. Absent once real output follows,
   *  because the output IS the answer. */
  readonly lastTurnEnd?: { readonly reason: string; readonly code?: string; readonly at: string };
  /** Every harness session that ever touched this artifact (D18); omitted
   *  when no event carries a stamp (old logs, stampless writers). */
  readonly sessionHistory?: readonly SessionHistoryRecord[];
}

/**
 * One harness session's association with an artifact, derived from attendant
 * stamps on the log events (D18). The artifact's lifetime provenance: born-in
 * first, every later attendant after, oldest association first.
 */
export interface SessionHistoryRecord {
  readonly harness: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly events: number;
}

/** Who last took delivery of feedback (advisory sidecar): display data with
 *  the copy-paste command that resumes their conversation, never executed. */
export interface AttendantRef {
  readonly harness: string;
  readonly at: string;
  readonly resume?: string;
  /** Model the attending session runs on, when its environment declared it -
   *  what the viewer's inherited (attended) pickers display. */
  readonly model?: string;
  /** Effort/reasoning level of the attending session, same provenance. */
  readonly effort?: string;
}

/** One model a harness offers, as `/hub/identity` reports it (registry v2). */
export interface HarnessModelInfo {
  readonly id: string;
  readonly label?: string;
  /** Effort levels this model accepts; absent = the harness-wide `efforts`. */
  readonly efforts?: readonly string[];
}

/**
 * One spawn recipe's picker vocabulary, as `/hub/identity` reports it in
 * `harnessInfo` (additive beside the legacy `harnesses` string[]). A harness
 * with no `models` has no model picker; one with no effort lists anywhere has
 * no effort picker.
 */
export interface HarnessInfo {
  readonly name: string;
  readonly models?: readonly HarnessModelInfo[];
  readonly defaultModel?: string;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
}

/** An artifact's sticky model/effort selection, as `GET/POST
 *  {base}/__lucid/selection` reads and writes it. Every unattended turn on
 *  the artifact reuses it; "default" (or absent) = the CLI decides. */
export interface SelectionState {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** `GET/POST {base}/__lucid/selection` response: the artifact's sticky pick
 *  plus the vocabulary it is made in, so the picker renders without a hub
 *  (a dedicated `lucid open` server has no `/hub/identity`). */
export interface SelectionResponse {
  /** The harness whose recipe validates this artifact's picks, when the
   *  registry has one for it. Absent = no recipe, so no pickers. */
  readonly harness?: string;
  /** Empty object when nothing is picked: the CLI's own defaults apply. */
  readonly selection: SelectionState;
  readonly info?: HarnessInfo;
  /** Every configured harness available as a continuation target. */
  readonly harnesses?: readonly HarnessInfo[];
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

/**
 * The attending conversation as it exists RIGHT NOW, when the harness lets us
 * see that. Present only while that session is actually running; absent means
 * either nothing is running or the harness publishes no such signal, which the
 * viewer must treat the same way - as "not open".
 *
 * Distinct from `agentsListening`, which counts agents blocked in `wait`: a
 * human with the conversation open and mid-thought is listening to nothing,
 * and is exactly who must not be talked over.
 */
export interface AttendantPresence {
  /** A terminal someone can type into, as opposed to a headless run. */
  readonly interactive: boolean;
  /** The harness's own live status, e.g. `idle` / `busy`. */
  readonly status?: string;
  /** Where that conversation is running. */
  readonly cwd?: string;
}

/** `/__lucid/state` response: the full folded payload plus viewer presence. */
export interface StateResponse extends WaitPayload {
  /** Agents currently blocked in `wait` on this session. */
  readonly agentsListening: number;
  readonly lastAttendant?: AttendantRef;
  /** The attending harness conversation, while it is open. Drives the panel's
   *  whole mode: interactive means the human owns the conversation, so the
   *  viewer states that and stops offering to drive it. */
  readonly attendantPresence?: AttendantPresence;
  /**
   * A harness conversation exists that a turn could RESUME - the artifact
   * carries a session id (a stamp, or one inside a recorded resume command).
   *
   * False for an artifact nobody has ever attended: a hand-written document, a
   * recovered file. Without this the panel announced "spawn mode" over an
   * artifact the engine would decline every time ("no harness session recorded"),
   * so feedback sat there looking as though a turn were coming.
   */
  readonly resumable?: boolean;
  /** Last-reported context-window usage of the attending harness, if any. */
  readonly contextUsage?: ContextUsage;
  /** The artifact's sticky model/effort for unattended turns, when one is
   *  picked. The pickers' own vocabulary comes from `/__lucid/selection`. */
  readonly selection?: SelectionState;
}

/** `/__lucid/sessions` response. */
export interface SessionsResponse {
  readonly root: string;
  readonly current: string;
  readonly sessions: readonly SessionSummary[];
}
