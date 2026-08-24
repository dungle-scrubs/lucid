/**
 * InputLedger — the deep submodule that owns the input-direction gauges.
 *
 * Extracted from `src/protocol/reducer.ts` (01): the reducer's 8-branch switch
 * smeared queue-depth, redeliver arming, and redeliver clearing across
 * `reducePostAttach:event` and `enqueueInput`. Now the queue discipline lives
 * here behind a small interface; a disposition fix touches this file only.
 * Pure and unit-testable without building a ChannelState.
 *
 * RFC-04 P2 added the second gauge: in-flight inputs, the real backlog.
 * Since hcn stopped queueing sends (ADR 0007), an accepted send is answered
 * `started` at once and the input leaves the disposition queue immediately,
 * so queueDepth reads zero however far behind the harness is. In-flight
 * counts what the harness has taken but not finished, and its edges are
 * reducer-visible frames:
 *
 * - RISES on the input's `applied` disposition — the durable record of
 *   delivery (both host strategies send it at the moment the input reaches
 *   the harness: hcn answered `started`, or the turn was spawned). Not at
 *   dispatch: replay and boundary redelivery re-send the same id, so
 *   counting sends would double-count one input, while the applied terminal
 *   is idempotent per id.
 * - FALLS on a turn's terminal event. Turns complete in order (the host
 *   pumps one at a time), so one terminal event retires one input.
 * - RESETS when the attachment ends (reducer: attach and detach set it to
 *   zero) — a takeover or detach aborts the old writer's turns, whose
 *   terminal events would arrive stale-epoch and be refused, so anything
 *   still counted could never fall out.
 *
 * queueDepth keeps its name and meaning: it is still the right number for
 * "awaiting a disposition". It is simply not the backlog.
 *
 * RFC-04's input bound gates on the in-flight gauge here: `atCapacity`
 * is the check `enqueueInput` refuses `input-queue-full` through, so the
 * bound and the quantity it bounds live in one module.
 */

import { EventKind, INPUT_QUEUE_MAX } from "../events.js";
import type { QueuedInput } from "../reducer.js";

const NO_INPUTS: readonly QueuedInput[] = Object.freeze([]);

/** Event kinds that terminate a turn — the fall edge of the in-flight
 * gauge. hcn's turn-scoped `done` ends every turn, exactly one per turn.
 * An `error` carrying `terminal: true` speaks for the SESSION, not a turn
 * (the host emits one when a session never opened, with no input
 * delivered), so counting it would drain a backlog that never existed. */
const TERMINAL_EVENT_KINDS: readonly unknown[] = [EventKind.done];

export const InputLedger = {
  /** The input bound's gate (RFC-04): a conversation already holding
   * INPUT_QUEUE_MAX in-flight inputs refuses new sends. Reads the
   * in-flight gauge, never queueDepth - queueDepth counts inputs awaiting
   * a disposition and reads zero under the exact backlog this catches
   * (ADR 0007), which is the trap revision 1 fell into. */
  atCapacity(inFlight: number): boolean {
    return inFlight >= INPUT_QUEUE_MAX;
  },

  /** Inputs still AWAITING a disposition — the gauge the host pages on.
   * Measures disposition round-trip, not backlog, since hcn stopped
   * queueing (ADR 0007): an accepted send is answered applied at once. */
  queueDepth(inputs: readonly QueuedInput[]): number {
    return inputs.filter((i) => i.status === "outstanding").length;
  },

  /** The input backlog's rise: one more input delivered to a harness, its
   * turn not terminal yet. */
  inputDelivered(inFlight: number): number {
    return inFlight + 1;
  },

  /** The input backlog's fall: one turn ended. Non-terminal kinds leave
   * the count alone; the clamp absorbs a turn no input opened (a
   * harness-spontaneous turn), so the gauge can never go negative. */
  turnEnded(inFlight: number, eventKind: unknown): number {
    return TERMINAL_EVENT_KINDS.includes(eventKind) ? Math.max(0, inFlight - 1) : inFlight;
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
export const atCapacity = (inFlight: number): boolean => InputLedger.atCapacity(inFlight);
export const redeliverable = (
  inputs: readonly QueuedInput[],
  sameTurn: boolean,
): readonly QueuedInput[] => InputLedger.redeliverable(inputs, sameTurn);
export const clearRedeliver = (
  inputs: readonly QueuedInput[],
  hadRedeliver: boolean,
): readonly QueuedInput[] => InputLedger.clearRedeliver(inputs, hadRedeliver);
