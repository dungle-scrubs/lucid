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

/** Source-side starvation policy (PLAN 4.5): while credit is exhausted the
 * pending buffer keeps AT MOST one entry per droppable kind - latest-wins
 * in value AND position (the superseded entry is removed, the incoming one
 * appended, so a coalesced delta never jumps ahead of lossless events that
 * preceded it). Lossless events are appended untouched; how many of those
 * the caller buffers is the caller's drain cadence, not this module's
 * bound. Shared by every adapter so the policy exists exactly once. */
export const coalesceDroppable = <E extends { readonly kind?: unknown }>(
  pending: readonly E[],
  incoming: E,
): readonly E[] =>
  classOfEventKind(incoming.kind) === "lossless"
    ? [...pending, incoming]
    : [...pending.filter((e) => e.kind !== incoming.kind), incoming];
