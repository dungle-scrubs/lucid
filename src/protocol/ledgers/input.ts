/**
 * InputLedger — the deep submodule that owns the disposition queue.
 *
 * Extracted from `src/protocol/reducer.ts` (01): the reducer's 8-branch switch
 * smeared queue-depth, redeliver arming, and redeliver clearing across
 * `reducePostAttach:event` and `enqueueInput`. Now the queue discipline lives
 * here behind a small interface; a disposition fix touches this file only.
 * Pure and unit-testable without building a ChannelState.
 */

import type { QueuedInput } from "../reducer.js";

const NO_INPUTS: readonly QueuedInput[] = Object.freeze([]);

export const InputLedger = {
  /** Inputs still AWAITING a disposition — the gauge the host pages on. */
  queueDepth(inputs: readonly QueuedInput[]): number {
    return inputs.filter((i) => i.status === "outstanding").length;
  },

  /** Inputs that need redelivery at a turn boundary (sameTurn → no redelivery). */
  redeliverable(inputs: readonly QueuedInput[], sameTurn: boolean): readonly QueuedInput[] {
    if (sameTurn) return NO_INPUTS;
    return inputs.filter((i) => i.redeliver);
  },

  /** Clear redeliver flags after they have been delivered. */
  clearRedeliver(inputs: readonly QueuedInput[], hadRedeliver: boolean): readonly QueuedInput[] {
    if (!hadRedeliver) return inputs;
    const flagged = inputs.some((i) => i.redeliver);
    return flagged ? inputs.map((i) => (i.redeliver ? { ...i, redeliver: false } : i)) : inputs;
  },
} as const;

export const queueDepth = (inputs: readonly QueuedInput[]): number =>
  InputLedger.queueDepth(inputs);
export const redeliverable = (
  inputs: readonly QueuedInput[],
  sameTurn: boolean,
): readonly QueuedInput[] => InputLedger.redeliverable(inputs, sameTurn);
export const clearRedeliver = (
  inputs: readonly QueuedInput[],
  hadRedeliver: boolean,
): readonly QueuedInput[] => InputLedger.clearRedeliver(inputs, hadRedeliver);
