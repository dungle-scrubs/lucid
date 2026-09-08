import { describe, expect, test } from "bun:test";
import {
  classOfEventKind,
  coalesceDroppable,
  DROPPABLE_KINDS,
  DROPPABLE_QUEUE_MAX,
  EventKind,
  LOSSLESS_KINDS,
  type PendingDroppable,
  supersedeTurn,
} from "../../src/protocol/events.js";

describe("event classes + coalescing (M4.3)", () => {
  test("the class split matches PLAN Part 0, and anything unclassifiable is lossless", () => {
    expect([...DROPPABLE_KINDS, ...LOSSLESS_KINDS].sort()).toEqual(Object.values(EventKind).sort());
    for (const kind of DROPPABLE_KINDS) expect(classOfEventKind(kind)).toBe("droppable");
    for (const kind of LOSSLESS_KINDS) expect(classOfEventKind(kind)).toBe("lossless");
    expect(classOfEventKind(undefined)).toBe("lossless");
    expect(classOfEventKind(42)).toBe("lossless");
    expect(classOfEventKind("brand-new-kind")).toBe("lossless");
    expect(DROPPABLE_QUEUE_MAX).toBeGreaterThan(0);
  });

  test("under starvation, coalescing is latest-wins per (turn, droppable kind), and a turn's lossless event supersedes its stale deltas", () => {
    let pending: readonly PendingDroppable<Record<string, unknown>>[] = [];

    pending = coalesceDroppable(pending, "t-1", { kind: "token", text: "a" });
    pending = coalesceDroppable(pending, "t-1", { kind: "token", text: "ab" });
    expect(pending).toEqual([{ turnId: "t-1", event: { kind: "token", text: "ab" } }]);

    // A different turn's deltas coalesce independently - flushing can
    // never re-stamp an event with a turn it did not belong to.
    pending = coalesceDroppable(pending, "t-1", { kind: "progress", note: "1/3" });
    pending = coalesceDroppable(pending, "t-2", { kind: "token", text: "x" });
    pending = coalesceDroppable(pending, "t-1", { kind: "token", text: "abc" });
    expect(pending).toEqual([
      { turnId: "t-1", event: { kind: "progress", note: "1/3" } },
      { turnId: "t-2", event: { kind: "token", text: "x" } },
      { turnId: "t-1", event: { kind: "token", text: "abc" } },
    ]);

    // t-1's trailing message supersedes t-1's pending deltas (the message
    // carries the whole text - a stale delta must never land after it);
    // t-2's survive untouched.
    pending = supersedeTurn(pending, "t-1");
    expect(pending).toEqual([{ turnId: "t-2", event: { kind: "token", text: "x" } }]);
  });
});
