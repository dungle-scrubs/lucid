/**
 * Owns the event-class policy shared by sources and the host:
 * which HarnessEvent kinds are droppable (coalescible under pressure,
 * latest-wins) vs lossless (never dropped, replay-covered), and the named
 * constants bounding the outbound and input directions. Pure vocabulary +
 * policy only - NOT responsible for enforcing credits (the reducer does),
 * for the input bound (the reducer refuses), or for transport.
 */

/** The outbound bound (PLAN 4.5): grantCredit clamps so credits
 * outstanding never exceed this, which bounds how many droppable frames
 * lucid can accept between render drains. It does NOT bound the lossless
 * class, which is never gated. */
export const DROPPABLE_QUEUE_MAX = 256;

/** The input bound (RFC-04, its Open Question 1 - decided here, on the
 * gauge P2 added). It bounds IN-FLIGHT inputs: delivered to a harness,
 * their turn not terminal yet, which is what InputLedger counts. 8, not
 * the 256 beside it: that bound absorbs machine-paced render traffic,
 * while one in-flight input is a turn a sender is waiting on, and neither
 * a human steering a chat nor a script batching work holds 8 unanswered
 * turns before the next reply - a sender past that is flooding, not
 * steering, and the refusal should name it. Small is safe only because
 * the gauge is real: queueDepth, which revision 1 proposed bounding,
 * reads zero under exactly the backlog this exists to catch (ADR 0007).
 * When `enqueueInput` refuses here (`input-queue-full`) it refuses
 * outright, never blocks - the bound is policy on durable state, and a
 * short-lived `lucid send` invoked from a shell has no caller to wait on
 * behalf of; a shell that hangs is worse than one that says no. */
export const INPUT_QUEUE_MAX = 8;

/** Single vocabulary for HarnessEvent kinds — the ONE place the kind
 * strings live. View, store, and protocol consumers import from here,
 * never mirror literals (C1). The droppable/lossless partition is
 * derived from the same strings so a rename is a single edit. */
export const EventKind = {
  token: "token",
  progress: "progress",
  context: "context",
  identity: "identity",
  message: "message",
  tool: "tool",
  limit: "limit",
  error: "error",
  /** The harness is asking the human something. hcn parses an
   * `hcn-question` block out of a turn and emits this beside the message
   * that carried it. Lossless by class - a question nobody sees is a
   * conversation that stops - and it was already treated that way, because
   * an unknown kind defaults to lossless. */
  question: "question",
  /** The harness naming what went wrong with a turn: class, reason, and
   * when a limit lifts. Lossless - a failure nobody sees reads as the
   * agent going quiet. */
  failure: "failure",
  done: "done",
} as const;

export type HarnessEventKind = (typeof EventKind)[keyof typeof EventKind];

export type EventClass = "droppable" | "lossless";

export const EVENT_CLASS = {
  context: "droppable",
  done: "lossless",
  error: "lossless",
  failure: "lossless",
  identity: "lossless",
  limit: "lossless",
  message: "lossless",
  progress: "droppable",
  question: "lossless",
  token: "droppable",
  tool: "lossless",
} as const satisfies Record<HarnessEventKind, EventClass>;

const kindsOf = (eventClass: EventClass): readonly HarnessEventKind[] =>
  Object.values(EventKind).filter((kind) => EVENT_CLASS[kind] === eventClass);

export const DROPPABLE_KINDS = kindsOf("droppable");
export const LOSSLESS_KINDS = kindsOf("lossless");

/** Class of a HarnessEvent kind. Unknown or malformed kinds are LOSSLESS:
 * data we cannot classify is data we must not drop. */
export const classOfEventKind = (kind: unknown): EventClass =>
  typeof kind === "string" && (DROPPABLE_KINDS as readonly string[]).includes(kind)
    ? "droppable"
    : "lossless";

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
