/**
 * Owns the event-class policy PLAN.md Part 0 declares and Part 1 uses:
 * which HarnessEvent kinds are droppable (coalescible under pressure,
 * latest-wins) vs lossless (never dropped, replay-covered), and the one
 * named constant bounding how many droppable frames may be in flight.
 * Pure vocabulary + policy only - NOT responsible for enforcing credits
 * (the reducer does) or for transport.
 */

/** The one named bound (PLAN 4.5): credits outstanding never exceed this,
 * which is what bounds lucid's droppable queue between render drains. */
export const DROPPABLE_QUEUE_MAX = 256;

/** Droppable: coalescible under pressure, latest-wins, credit-gated. */
export const DROPPABLE_KINDS = ["token", "progress", "context"] as const;

export type EventClass = "droppable" | "lossless";

/** Class of a HarnessEvent kind. Unknown or malformed kinds are LOSSLESS:
 * data we cannot classify is data we must not drop. */
export const classOfEventKind = (kind: unknown): EventClass =>
  typeof kind === "string" && (DROPPABLE_KINDS as readonly string[]).includes(kind)
    ? "droppable"
    : "lossless";

/** Source-side starvation policy (PLAN 4.5): while credit is exhausted the
 * pending buffer keeps AT MOST one entry per droppable kind (latest-wins,
 * replaced in place - droppables are ephemeral render state, so relative
 * order against lossless events is not preserved for a superseded delta)
 * and every lossless event, which is never dropped or replaced. Shared by
 * every adapter so the policy exists exactly once. */
export const coalesceDroppable = <E extends { readonly kind?: unknown }>(
  pending: readonly E[],
  incoming: E,
): readonly E[] => {
  if (classOfEventKind(incoming.kind) === "lossless") return [...pending, incoming];
  const at = pending.findIndex((e) => e.kind === incoming.kind);
  if (at === -1) return [...pending, incoming];
  return pending.map((e, i) => (i === at ? incoming : e));
};
