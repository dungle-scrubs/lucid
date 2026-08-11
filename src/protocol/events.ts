/**
 * Owns the event-class policy PLAN.md Part 0 declares and Part 1 uses:
 * which HarnessEvent kinds are droppable (coalescible under pressure,
 * latest-wins) vs lossless (never dropped, replay-covered), and the one
 * named constant bounding outstanding flow credits. Pure vocabulary +
 * policy only - NOT responsible for enforcing credits (the reducer does)
 * or for transport.
 */

/** The one named bound (PLAN 4.5): grantCredit clamps so credits
 * outstanding never exceed this, which bounds how many droppable frames
 * lucid can accept between render drains. It does NOT bound the lossless
 * class, which is never gated. */
export const DROPPABLE_QUEUE_MAX = 256;

/** Droppable: coalescible under pressure, latest-wins, credit-gated. */
export const DROPPABLE_KINDS = ["token", "progress", "context"] as const;

/** Lossless: never dropped, never credit-gated, replay-covered. */
export const LOSSLESS_KINDS = ["identity", "message", "tool", "limit", "error", "done"] as const;

export type EventClass = "droppable" | "lossless";

/** Class of a HarnessEvent kind. Unknown or malformed kinds are LOSSLESS:
 * data we cannot classify is data we must not drop. */
export const classOfEventKind = (kind: unknown): EventClass =>
  typeof kind === "string" && (DROPPABLE_KINDS as readonly string[]).includes(kind)
    ? "droppable"
    : "lossless";

/** The drift probe: an unknown kind still flows (as lossless), but the
 * host can log it - a harness renaming an event kind must be detectable
 * at exactly this seam. */
export const isKnownEventKind = (kind: unknown): boolean =>
  typeof kind === "string" &&
  ((DROPPABLE_KINDS as readonly string[]).includes(kind) ||
    (LOSSLESS_KINDS as readonly string[]).includes(kind));

/** A droppable event waiting for credit, still owned by the turn that
 * produced it - flushing must never re-stamp an event with a turn it did
 * not belong to. */
export interface PendingDroppable<E> {
  readonly turnId: string;
  readonly event: E;
}

/** Source-side starvation policy (PLAN 4.5): while credit is exhausted the
 * pending buffer keeps AT MOST one entry per (turnId, droppable kind) -
 * latest-wins in value AND position. Droppables ONLY: the caller sends
 * lossless immediately (never buffered, never dropped) and calls
 * supersedeTurn when a lossless event closes over a turn's deltas. Shared
 * by every adapter so the policy exists exactly once. */
export const coalesceDroppable = <E extends { readonly kind?: unknown }>(
  pending: readonly PendingDroppable<E>[],
  turnId: string,
  incoming: E,
): readonly PendingDroppable<E>[] => [
  ...pending.filter((p) => !(p.turnId === turnId && p.event.kind === incoming.kind)),
  { turnId, event: incoming },
];

/** A lossless event for a turn SUPERSEDES that turn's pending droppables:
 * the trailing message/done carries the whole text (PLAN Part 0: a turn's
 * text arrives twice by design - render one), so a stale delta must never
 * land after it. */
export const supersedeTurn = <E>(
  pending: readonly PendingDroppable<E>[],
  turnId: string,
): readonly PendingDroppable<E>[] => pending.filter((p) => p.turnId !== turnId);
