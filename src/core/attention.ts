/**
 * The attention fold (plan 03, M1.1).
 *
 * The grouped tab strip needs, per open artifact, four signals and nothing
 * else: how many questions are open, whether the agent is mid-turn, whether the
 * review is approved, and the log's high-water seq (so a consumer can tell
 * "new since I last looked"). `attentionOf` derives exactly those from the
 * folded state - a projection over the tested `foldLog`, so it can never
 * disagree with the fold the rest of the app trusts.
 *
 * Because the strip polls every open tab, folding each log every poll is the
 * cost this milestone exists to avoid. That cache is `sessionState`'s
 * (src/core/log.ts) and is shared with every other reader of a session log; a
 * caller here just folds through it.
 */

import type { FoldedState } from "./fold.ts";

export interface Attention {
  /** Questions the human has not answered or skipped - the top precedence. */
  readonly openQuestions: number;
  /** The agent-work window is open (an ack with no agent output after it). */
  readonly working: boolean;
  /** The review has been approved. */
  readonly resolved: boolean;
  /** The log's high-water seq: the floor a consumer compares "last viewed" to. */
  readonly lastEventSeq: number;
}

/** Reduce a session's folded state to the four attention signals. Pure. */
export const attentionOf = (s: FoldedState): Attention => ({
  // `foldLog` marks a skipped or unclear question `answered:true` too, so
  // `!answered` alone is the open count (a re-ask lands as a NEW question id).
  openQuestions: s.questions.filter((q) => !q.answered).length,
  working: s.agentWorking != null,
  resolved: s.reviewResolved,
  lastEventSeq: s.highSeq,
});
