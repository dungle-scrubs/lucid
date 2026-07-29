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
