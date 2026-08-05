/**
 * The tab badge's state, resolved by rule (plan 03, M3.1, D-018).
 *
 * A tab wears exactly ONE badge, picked by precedence:
 * question > working > finished-unseen > settled. The inputs come from the
 * hub's attention map (or, absent one, the tab's own fold) plus the
 * per-machine unseen marker (M3.2); this function is the single place the
 * ordering lives, so the strip renders a decision rather than making one.
 */

export type TabAttentionState = "question" | "working" | "finished-unseen" | "settled";

export interface AttentionInputs {
  /** Unanswered questions - the human owes an answer. */
  readonly openQuestions: number;
  /** The agent-work window is open. */
  readonly working: boolean;
  /** The log grew past what this machine last viewed (M3.2). Approval carries
   *  no badge of its own: an approved review with nothing unseen is settled. */
  readonly unseen: boolean;
}

export const attentionStateOf = (a: AttentionInputs): TabAttentionState => {
  if (a.openQuestions > 0) return "question";
  if (a.working) return "working";
  if (a.unseen) return "finished-unseen";
  return "settled";
};

/**
 * Did the log grow past what this machine last viewed (M3.2, D-025)? An
 * absent mark is SEEN, not unseen - both for a tab never activated here and
 * for a payload stored before the marker existed (the upgrade rule): a wall
 * of stale badges on upgrade would teach the human to ignore the badge.
 */
export const isUnseen = (lastEventSeq: number, viewed: number | undefined): boolean =>
  viewed !== undefined && lastEventSeq > viewed;

/** One hub attention row, as the hub's fold reports it. */
export interface HubRow {
  readonly openQuestions: number;
  readonly working: boolean;
  readonly lastEventSeq: number;
}

/** The session's own fold (from the live store), used only when the tab is live. */
export interface OwnFold {
  readonly openQuestions: boolean;
  readonly working: boolean;
}

/** All inputs tabAttention needs, as plain values (no store handle). */
export interface TabAttentionInputs {
  /** The hub's attention row for this tab's artifact, if the hub has one. */
  readonly hub: HubRow | undefined;
  /** The session's own fold - live SSE push, only trusted when connected. */
  readonly own: OwnFold;
  /** Whether the tab's session is connected (live union vs hub-only). */
  readonly live: boolean;
  /** Whether this is the active tab (unseen is a background state). */
  readonly active: boolean;
  /** The last event seq this machine viewed. */
  readonly viewed: number | undefined;
}

/** The result of tabAttention: a state plus the inputs that resolved it, so the
 *  component is a pure renderer. */
export interface TabAttentionResult {
  readonly state: TabAttentionState;
  readonly hub: HubRow | undefined;
  readonly live: boolean;
  readonly active: boolean;
}

/** Resolve the live/evicted union and the active-tab guard into a badge state.
 *  A live tab unions the hub row with its own fold (push is instant); an
 *  evicted tab reads the hub row alone (a frozen store must not hold a stale
 *  dot). The active tab is never unseen. */
export const tabAttention = (inputs: TabAttentionInputs): TabAttentionResult => {
  const { hub, own, live, active, viewed } = inputs;
  const openQuestions = live
    ? Math.max(hub?.openQuestions ?? 0, own.openQuestions ? 1 : 0)
    : (hub?.openQuestions ?? 0);
  const working = live ? (hub?.working ?? false) || own.working : (hub?.working ?? false);
  const unseen = !active && hub !== undefined && isUnseen(hub.lastEventSeq, viewed);
  return {
    active,
    hub,
    live,
    state: attentionStateOf({ openQuestions, unseen, working }),
  };
};

/** The id↔artifact join: find the hub attention row for an artifact key.
 *  Previously done inline in the component; this owns it in one place. */
export const hubAttentionFor = (
  sessions: readonly { readonly artifact: string; readonly id: string }[],
  attention: Readonly<Record<string, HubRow>>,
  key: string,
): HubRow | undefined => {
  const id = sessions.find((row) => row.artifact === key)?.id;
  return id !== undefined ? attention[id] : undefined;
};
