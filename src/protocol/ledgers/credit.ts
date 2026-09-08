/**
 * CreditLedger — the deep submodule that owns droppable flow control.
 *
 * Extracted from `src/protocol/reducer.ts` (01): the bounded-queue invariant
 * (DROPPABLE_QUEUE_MAX clamp) lived as two one-liners inside the reducer's
 * event and grantCredit branches. Now the clamp and starvation gate live
 * here; a credit fix touches this file only.
 */

import { DROPPABLE_QUEUE_MAX } from "../events.js";
import type { ChannelState } from "../reducer.js";

export const CreditLedger = {
  /** Whether a droppable event is starved. */
  isStarved(state: ChannelState): boolean {
    return state.credits <= 0;
  },

  /** Clamped grant — the bounded queue invariant. */
  clampedGrant(state: ChannelState, tokens: number): number {
    return Math.min(tokens, DROPPABLE_QUEUE_MAX - state.credits);
  },
} as const;
