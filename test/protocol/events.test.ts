import { describe, expect, test } from "bun:test";
import {
  classOfEventKind,
  coalesceDroppable,
  DROPPABLE_KINDS,
  DROPPABLE_QUEUE_MAX,
  isKnownEventKind,
  LOSSLESS_KINDS,
} from "../../src/protocol/events.js";

describe("event classes + coalescing (M4.3)", () => {
  test("the class split matches PLAN Part 0, and anything unclassifiable is lossless", () => {
    expect([...DROPPABLE_KINDS]).toEqual(["token", "progress", "context"]);
    expect([...LOSSLESS_KINDS]).toEqual(["identity", "message", "tool", "limit", "error", "done"]);
    for (const kind of DROPPABLE_KINDS) expect(classOfEventKind(kind)).toBe("droppable");
    for (const kind of LOSSLESS_KINDS) expect(classOfEventKind(kind)).toBe("lossless");
    expect(classOfEventKind(undefined)).toBe("lossless");
    expect(classOfEventKind(42)).toBe("lossless");
    expect(classOfEventKind("brand-new-kind")).toBe("lossless");
    // Unknown kinds are treated lossless but stay DETECTABLE - the drift
    // probe for a harness that renames an event kind.
    for (const kind of [...DROPPABLE_KINDS, ...LOSSLESS_KINDS])
      expect(isKnownEventKind(kind)).toBe(true);
    expect(isKnownEventKind("brand-new-kind")).toBe(false);
    expect(isKnownEventKind(undefined)).toBe(false);
    expect(DROPPABLE_QUEUE_MAX).toBeGreaterThan(0);
  });

  test("under starvation, coalescing is latest-wins per droppable kind and never touches the lossless class", () => {
    let pending: readonly Record<string, unknown>[] = [];

    pending = coalesceDroppable(pending, { kind: "token", text: "a" });
    pending = coalesceDroppable(pending, { kind: "token", text: "ab" });
    expect(pending).toEqual([{ kind: "token", text: "ab" }]);

    pending = coalesceDroppable(pending, { kind: "progress", note: "1/3" });
    pending = coalesceDroppable(pending, { kind: "message", text: "kept" });
    pending = coalesceDroppable(pending, { kind: "token", text: "abc" });
    pending = coalesceDroppable(pending, { kind: "progress", note: "2/3" });
    pending = coalesceDroppable(pending, { kind: "message", text: "also kept" });

    // Latest-wins collapsed each droppable kind to one entry - and holds
    // for POSITION too: the superseding value sits where it arrived, never
    // ahead of lossless events that preceded it. Both messages survived.
    expect(pending).toEqual([
      { kind: "message", text: "kept" },
      { kind: "token", text: "abc" },
      { kind: "progress", note: "2/3" },
      { kind: "message", text: "also kept" },
    ]);
  });
});
