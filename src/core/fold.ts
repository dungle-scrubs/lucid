import type { Anchor } from "../anchors/anchor.ts";
import type {
  AgentProgress,
  AgentWorking,
  QuestionOption,
  SessionHistoryRecord,
} from "../protocol/wire.ts";
import type { LogEvent, PromptImage } from "./events.ts";
import type { ItemAnswer, QuestionItem } from "./question-contract.ts";
import { maxSeq } from "./log.ts";

export type SessionStatus = "none" | "active" | "suspended" | "ended";

export interface AnnotationRecord {
  readonly id: string;
  readonly seq: number;
  readonly version: number;
  readonly target: Anchor;
  /** Every spot the note covers when there are several; `target` is the first. */
  readonly targets?: readonly Anchor[];
  readonly note: string;
  readonly at: string;
  /** Authorship time when the client supplied one; display-order metadata. */
  readonly authoredAt?: string;
  readonly images?: readonly PromptImage[];
}

export interface ForkRecord {
  readonly id: string;
  readonly seq: number;
  readonly version: number;
  readonly target: Anchor;
  readonly note: string;
  readonly at: string;
  readonly authoredAt?: string;
  readonly images?: readonly PromptImage[];
}

export interface MessageRecord {
  readonly role: "human" | "agent";
  readonly seq: number;
  readonly text: string;
  readonly at: string;
  readonly refs?: readonly string[];
  readonly images?: readonly PromptImage[];
}

export interface RevertRecord {
  readonly id: string;
  readonly seq: number;
  readonly target: Anchor;
  readonly targetVersion: number;
  readonly why: string;
  readonly at: string;
}

export interface QuestionRecord {
  readonly id: string;
  readonly seq: number;
  readonly text: string;
  readonly ref?: string;
  readonly options?: readonly QuestionOption[];
  readonly multi?: boolean;
  /** The rich grouped question (D12), when the agent asked one. */
  readonly group?: readonly QuestionItem[];
  readonly answered: boolean;
  readonly skipped?: boolean;
  readonly unclear?: boolean;
  readonly answer?: string;
  readonly answerOptions?: readonly string[];
  /** Per-question answers to a grouped question, in the group's order. */
  readonly items?: readonly ItemAnswer[];
  readonly answerAnchor?: Anchor;
  /** Every pinned region when there are several; `answerAnchor` is the first. */
  readonly answerAnchors?: readonly Anchor[];
  readonly answerImages?: readonly PromptImage[];
  /** seq of the answer event (for delta detection). */
  readonly answerSeq?: number;
  /** When the answer landed. The Q&A enters the transcript HERE, not at `at`
   *  (D14): the question and its answer are one item, positioned at the moment
   *  the human settled it. */
  readonly answeredAt?: string;
  readonly at: string;
}

export interface VersionRef {
  readonly version: number;
  readonly hash: string;
  readonly path: string;
  readonly seq: number;
}

export interface FoldedState {
  /** Every harness session that ever touched this artifact, in first-touch
   *  order (D18: derived from event stamps, oldest association first). */
  readonly sessionHistory: readonly SessionHistoryRecord[];
  readonly status: SessionStatus;
  /** Current lifecycle segment number (1-based). */
  readonly segment: number;
  /** Current artifact version (segment-scoped; resets to 1 each segment). */
  readonly version: number;
  readonly reviewResolved: boolean;
  /** seq of the last review_resolved/review_reopened toggle in the segment (0 if none). */
  readonly reviewToggleSeq: number;
  /** Live annotations of the current segment, in log order (D-056). */
  readonly annotations: readonly AnnotationRecord[];
  /** Fork requests of the current segment, in log order. Consumed by the
   *  attending agent (spin off a new artifact), never folded into this one. */
  readonly forks: readonly ForkRecord[];
  /** Conversation of the current segment, in log order. */
  readonly messages: readonly MessageRecord[];
  /** Revert decisions of the current segment, in log order. */
  readonly reverts: readonly RevertRecord[];
  /** Agent questions (with answers) of the current segment, in log order. */
  readonly questions: readonly QuestionRecord[];
  /** Version refs of the current segment (for snapshot lookup). */
  readonly versions: readonly VersionRef[];
  /** Artifact basename recorded at session_opened. */
  readonly artifact: string;
  /** Highest seq across the WHOLE log (nextCursor floor). */
  readonly highSeq: number;
  /** Last seq that is not an agent_ack: `wait` blocks past ack-only deltas. */
  readonly lastNonAckSeq: number;
  /** Highest seq an agent has CLAIMED delivery of in the current segment (0 if
   *  none): the largest `covers` on any ack. An item at or below it was in a
   *  batch someone took (D20). An ack that claims no range - a presence-only
   *  `intent`/`progress` re-ack, or a pre-D20 writer - moves nothing. */
  readonly deliveredThroughSeq: number;
  /** Highest agent OUTPUT seq in the current segment - version, agent_reply,
   *  question (0 if none). An item strictly below it was already followed by
   *  something the agent produced (D20). */
  readonly lastAgentOutputSeq: number;
  /** Open "agent is working" window: set by agent_ack, closed by any agent
   *  output (version, reply, question) within the segment. A re-ack may add
   *  declared intent; the window's `since` stays the first ack's time. */
  readonly agentWorking: AgentWorking | null;
  /**
   * The last turn to END without any agent output following it, if any.
   *
   * A terminator CLOSES the working window, which is right - the agent is not
   * working. But closing it silently loses the outcome: a turn that read the
   * feedback and correctly decided nothing was needed looks identical to one
   * that never happened, and the human is left with feedback marked delivered
   * and no idea what came of it. This is what lets the viewer say so (OQ-3).
   *
   * Null once any output follows: a version or reply IS the answer, and needs
   * no separate line saying a turn ended.
   */
  readonly lastTurnEnd: {
    readonly reason: string;
    readonly code?: string;
    readonly at: string;
  } | null;
  /** seq of the session_opened that begins the current segment. */
  readonly segmentStartSeq: number;
}

const LIFECYCLE = new Set([
  "session_opened",
  "session_resumed",
  "session_suspended",
  "session_ended",
]);

/**
 * Which events may return a blocked `wait` (`lastNonAckSeq`, read by
 * `runWait`). Stated as a SET rather than as "everything that is not an
 * `agent_ack`, because the negative form silently enrolls every event added
 * later. Presence traffic in particular must never wake a waiter: an ack is
 * an agent talking about itself, not feedback for anyone, and a turn-lifecycle
 * event is the same kind of thing. Under the old form, adding one would have
 * woken every agent blocked on the log - agent B returning `waiting` because
 * agent A's turn ended.
 *
 * Adding an event type here is a decision about whether it is worth waking a
 * blocked agent for. That is exactly the decision that should be hard to make
 * by accident.
 */
const WAKES_WAIT: ReadonlySet<LogEvent["t"]> = new Set<LogEvent["t"]>([
  "session_opened",
  "session_resumed",
  "session_suspended",
  "session_ended",
  "version",
  "annotation",
  "fork",
  "prompt",
  "agent_reply",
  "revert",
  "question",
  "question_answered",
  "review_resolved",
  "review_reopened",
]);

const statusFromLifecycle = (t: string): SessionStatus => {
  switch (t) {
    case "session_opened":
    case "session_resumed":
      return "active";
    case "session_suspended":
      return "suspended";
    case "session_ended":
      return "ended";
    default:
      return "none";
  }
};

/** Derive the artifact's session history from attendant stamps (D18):
 *  whole-log, not segment-scoped - provenance is the artifact's lifetime
 *  story, and there is no second store to drift. */
const deriveSessionHistory = (events: readonly LogEvent[]): SessionHistoryRecord[] => {
  const byKey = new Map<string, SessionHistoryRecord>();
  for (const e of events) {
    const stamp = "attendant" in e ? e.attendant : undefined;
    if (!stamp) continue;
    // JSON tuple key: collision-free even if a stamp smuggled a separator
    // (the writers strip control chars, but the fold must not depend on it).
    const key = JSON.stringify([stamp.harness, stamp.sessionId ?? ""]);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        // A later stamp may know details an earlier one lacked (cwd from a
        // fuller writer): first-known wins, absent fills in.
        ...(existing.cwd === undefined && stamp.cwd ? { cwd: stamp.cwd } : {}),
        lastAt: e.at,
        events: existing.events + 1,
      });
    } else {
      byKey.set(key, {
        harness: stamp.harness,
        ...(stamp.sessionId ? { sessionId: stamp.sessionId } : {}),
        ...(stamp.cwd ? { cwd: stamp.cwd } : {}),
        firstAt: e.at,
        lastAt: e.at,
        events: 1,
      });
    }
  }
  return [...byKey.values()];
};

/**
 * Fold the event log to current state. Lifecycle status derives from the latest
 * lifecycle event across the whole log (D-049); current version, reviewResolved,
 * the live annotation set, and the conversation derive from the latest segment
 * only (D-056). Earlier segments are read-only history.
 */
export const foldLog = (events: readonly LogEvent[]): FoldedState => {
  const highSeq = maxSeq(events);
  const lastNonAckSeq = maxSeq(events.filter((e) => WAKES_WAIT.has(e.t)));

  if (events.length === 0) {
    return {
      status: "none",
      sessionHistory: [],
      segment: 0,
      version: 0,
      reviewResolved: false,
      reviewToggleSeq: 0,
      annotations: [],
      forks: [],
      messages: [],
      reverts: [],
      questions: [],
      versions: [],
      artifact: "",
      highSeq,
      lastNonAckSeq,
      deliveredThroughSeq: 0,
      lastAgentOutputSeq: 0,
      agentWorking: null,
      lastTurnEnd: null,
      segmentStartSeq: 0,
    };
  }

  // Latest lifecycle event anywhere -> status.
  let status: SessionStatus = "none";
  for (const e of events) if (LIFECYCLE.has(e.t)) status = statusFromLifecycle(e.t);

  // Current segment begins at the last session_opened. NOTE the two scan scopes
  // are intentionally different (D-056): status (above) is the latest lifecycle
  // event ANYWHERE in the log, while segment content (below) starts at the last
  // `session_opened` so a suspend->resume keeps the same segment's annotations
  // and conversation. Earlier segments are read-only history.
  let segStart = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.t === "session_opened") segStart = i;
  }
  const segmentEvents = events.slice(segStart);
  const opened = segmentEvents[0];

  let segment = 1;
  let version = 1;
  let artifact = "";
  let segmentStartSeq = 0;
  const versions: VersionRef[] = [];
  const annotations: AnnotationRecord[] = [];
  const forks: ForkRecord[] = [];
  const messages: MessageRecord[] = [];
  const reverts: RevertRecord[] = [];
  const questionMap = new Map<string, QuestionRecord>();
  const questionOrder: string[] = [];
  let reviewResolved = false;
  let reviewToggleSeq = 0;

  if (opened && opened.t === "session_opened") {
    segment = opened.segment;
    version = opened.version;
    artifact = opened.artifact;
    segmentStartSeq = opened.seq;
    versions.push({
      version: opened.version,
      hash: opened.hash,
      path: opened.path,
      seq: opened.seq,
    });
  }

  for (const e of segmentEvents) {
    switch (e.t) {
      case "version":
        version = e.version;
        versions.push({ version: e.version, hash: e.hash, path: e.path, seq: e.seq });
        break;
      case "annotation":
        annotations.push({
          id: e.id,
          seq: e.seq,
          version: e.version,
          target: e.target,
          ...(e.targets && e.targets.length > 0 ? { targets: e.targets } : {}),
          note: e.note,
          at: e.at,
          ...(e.authoredAt ? { authoredAt: e.authoredAt } : {}),
          ...(e.images ? { images: e.images } : {}),
        });
        break;
      case "fork":
        forks.push({
          id: e.id,
          seq: e.seq,
          version: e.version,
          target: e.target,
          note: e.note,
          at: e.at,
          ...(e.authoredAt ? { authoredAt: e.authoredAt } : {}),
          ...(e.images ? { images: e.images } : {}),
        });
        break;
      case "prompt":
        messages.push({
          role: "human",
          seq: e.seq,
          text: e.text,
          at: e.at,
          refs: e.refs,
          ...(e.images ? { images: e.images } : {}),
        });
        break;
      case "agent_reply":
        messages.push({ role: "agent", seq: e.seq, text: e.text, at: e.at });
        break;
      case "revert":
        reverts.push({
          id: e.id,
          seq: e.seq,
          target: e.target,
          targetVersion: e.targetVersion,
          why: e.why,
          at: e.at,
        });
        break;
      case "question":
        if (!questionMap.has(e.id)) {
          questionMap.set(e.id, {
            id: e.id,
            seq: e.seq,
            text: e.text,
            ...(e.ref ? { ref: e.ref } : {}),
            ...(e.options && e.options.length > 0 ? { options: e.options } : {}),
            ...(e.multi ? { multi: true } : {}),
            ...(e.group && e.group.length > 0 ? { group: e.group } : {}),
            answered: false,
            at: e.at,
          });
          questionOrder.push(e.id);
        }
        break;
      case "question_answered": {
        const q = questionMap.get(e.questionId);
        if (q) {
          // Rebuilt from the ASK-time fields, never spread over the previous
          // record: a later answer REPLACES an earlier one, and spreading would
          // leave a skip's flag (or its predecessor's items) on top of it.
          // Last wins (a skip then a real answer shows the answer). The
          // double-click race #40's first-wins guard existed for is stopped
          // at the source now: the chrome holds an in-flight set across
          // Answer/Skip/Re-ask, so one gesture appends one event.
          questionMap.set(e.questionId, {
            id: q.id,
            seq: q.seq,
            text: q.text,
            at: q.at,
            ...(q.ref ? { ref: q.ref } : {}),
            ...(q.options ? { options: q.options } : {}),
            ...(q.multi ? { multi: true } : {}),
            ...(q.group ? { group: q.group } : {}),
            answered: true,
            answer: e.text,
            answerSeq: e.seq,
            answeredAt: e.at,
            ...(e.skipped ? { skipped: true } : {}),
            ...(e.unclear ? { unclear: true } : {}),
            ...(e.options && e.options.length > 0 ? { answerOptions: e.options } : {}),
            ...(e.items && e.items.length > 0 ? { items: e.items } : {}),
            ...(e.anchor ? { answerAnchor: e.anchor } : {}),
            ...(e.anchors && e.anchors.length > 0 ? { answerAnchors: e.anchors } : {}),
            ...(e.images && e.images.length > 0 ? { answerImages: e.images } : {}),
          });
        }
        break;
      }
      case "review_resolved":
        reviewResolved = true;
        reviewToggleSeq = e.seq;
        break;
      case "review_reopened":
        reviewResolved = false;
        reviewToggleSeq = e.seq;
        break;
      default:
        break;
    }
  }

  // Presence: an ack opens a turn's working window; that turn's own output
  // closes it. Separate pass so the content fold above stays untouched by
  // metadata.
  //
  // Keyed by TURN, not one scalar. Lucid permits two agents on one artifact,
  // and with a single window turn A's output closed turn B's, while A's late
  // ack reopened a window after A had finished (D-013). An ack with no
  // `turnId` belongs to the ANONYMOUS turn, which is how every log written
  // before this folds - so nothing historical changes shape.
  const ANON = "";
  interface OpenTurn {
    since: string;
    intent?: "revise" | "reply";
    progress?: AgentProgress;
  }
  const openTurns = new Map<string, OpenTurn>();
  // Turns that have already closed in this segment. A late ack MUST NOT
  // reopen one: an agent that finished and then flushed a queued progress
  // line would otherwise look alive again, forever.
  const closedTurns = new Set<string>();
  // The last turn to end with nothing after it (see FoldedState.lastTurnEnd).
  let lastTurnEnd: { reason: string; code?: string; at: string } | null = null;
  // Delivery cursors (D20). They are NOT the working window: that opens and
  // closes, while these only ever advance within the segment.
  let deliveredThroughSeq = 0;
  let lastAgentOutputSeq = 0;
  for (const e of segmentEvents) {
    if (e.t === "agent_ack") {
      // The claimed range, never the ack's own position: an ack lands AFTER
      // the read it acknowledges, so feedback in between was not delivered.
      if (typeof e.covers === "number" && Number.isInteger(e.covers)) {
        deliveredThroughSeq = Math.max(deliveredThroughSeq, e.covers);
      }
      const turn = e.turnId ?? ANON;
      // A turn that already ended stays ended for the segment.
      if (closedTurns.has(turn)) continue;
      // A re-ack refines the open window (declared intent + fan-out progress)
      // without restarting its clock; the first ack's time is when delivery
      // happened. Progress is last-writer-wins so `done` can climb across acks.
      const open = openTurns.get(turn) ?? { since: e.at };
      if (e.intent) open.intent = e.intent;
      // Merge, don't replace: fields arrive on separate acks (start with
      // --total, later bump --done), so each refines the report rather than
      // wiping the ones it omits.
      if (e.progress) open.progress = { ...open.progress, ...e.progress };
      openTurns.set(turn, open);
    } else if (e.t === "version" || e.t === "agent_reply" || e.t === "question") {
      lastAgentOutputSeq = e.seq;
      // Output closes the turn that PRODUCED it, not whatever happened to be
      // open. Untagged output closes the anonymous turn, which is the only
      // one a pre-turnId writer can have opened.
      const turn = e.turnId ?? ANON;
      openTurns.delete(turn);
      closedTurns.add(turn);
      // Real output answers the feedback, so a "the turn ended" line would be
      // noise beside it.
      lastTurnEnd = null;
    } else if (e.t === "agent_turn_ended") {
      // The turn said it stopped. Only the turn it names, and only the window:
      // a turn that produced nothing has answered nothing, so no cursor moves
      // (D-018). A terminator naming a turn nobody opened is ignored - with
      // turn identity that is safe, and without it, it would have closed
      // somebody else's window.
      openTurns.delete(e.turnId);
      closedTurns.add(e.turnId);
      lastTurnEnd = { reason: e.reason, ...(e.code ? { code: e.code } : {}), at: e.at };
    } else if (e.t === "session_ended") {
      // A session that is over has no turn running. Without this the window
      // opened by an ack survived forever whenever the turn produced no
      // output - the viewer kept saying the agent was responding beside a
      // header reading `approved` (plan 08 finding #1).
      //
      // `session_ended` ONLY. Suspension is not evidence a turn ended: it
      // fires on "no subscribers and status active", which is a human closing
      // the viewer while an agent legitimately works, and `session_resumed`
      // stays in the same segment - so closing here would erase a live turn
      // permanently. `review_resolved` is not evidence either; approval
      // describes the review, not the agent.
      //
      // Deliberately NOT lastAgentOutputSeq: ending a session produced no
      // output, and advancing that cursor would mark undelivered feedback
      // answered (payload.ts reads it for exactly that).
      //
      // EVERY turn, not one: the session is over, so none of them is running.
      for (const id of openTurns.keys()) closedTurns.add(id);
      openTurns.clear();
    }
  }
  // The OLDEST open turn is the one the viewer paints. With one turn - which
  // is every artifact today - this is exactly what a single scalar produced,
  // so nothing renders differently. With two, the oldest is the one the human
  // has been waiting on longest, which is the one worth a clock.
  const oldestOpen = [...openTurns.values()].reduce<OpenTurn | null>(
    (oldest, t) => (oldest === null || t.since < oldest.since ? t : oldest),
    null,
  );
  const agentWorking = oldestOpen
    ? {
        since: oldestOpen.since,
        ...(oldestOpen.intent ? { intent: oldestOpen.intent } : {}),
        ...(oldestOpen.progress ? { progress: oldestOpen.progress } : {}),
      }
    : null;

  return {
    status,
    sessionHistory: deriveSessionHistory(events),
    segment,
    version,
    reviewResolved,
    reviewToggleSeq,
    annotations,
    forks,
    messages,
    reverts,
    questions: questionOrder.map((id) => questionMap.get(id)!),
    versions,
    artifact,
    highSeq,
    lastNonAckSeq,
    deliveredThroughSeq,
    lastAgentOutputSeq,
    agentWorking,
    lastTurnEnd,
    segmentStartSeq,
  };
};

/** Look up the version ref a given version number maps to within the segment. */
export const versionRef = (state: FoldedState, version: number): VersionRef | undefined =>
  state.versions.find((v) => v.version === version);
