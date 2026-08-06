import { describe, expect, test } from "bun:test";
import { numberAnnotations } from "../client/shared/numbering.ts";

/**
 * M4.1: the one badge-numbering function, shared by the panel timeline (the
 * card numbers) and the overlay markers (the badge numbers). A card and its
 * badge must wear the SAME number for the click-to-jump to land; two
 * independent counts used to drift on the orphan edge.
 */
describe("M4.1: numberAnnotations - the one id->number rule", () => {
  test("resolved annotations number 1, 2, 3 in record order", () => {
    const numbers = numberAnnotations(
      [
        { id: "a", resolved: true },
        { id: "b", resolved: true },
        { id: "c", resolved: true },
      ],
      [],
    );
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
    expect(numbers.get("c")).toBe(3);
  });

  test("unresolved (orphan) annotations are skipped - they have no mark", () => {
    // An orphan advances no number: the next resolved annotation keeps the
    // number the orphan would have shifted off. This is the off-by-one the
    // two counts used to disagree on.
    const numbers = numberAnnotations(
      [
        { id: "a", resolved: true },
        { id: "orphan", resolved: false },
        { id: "b", resolved: true },
      ],
      [],
    );
    expect(numbers.get("a")).toBe(1);
    expect(numbers.has("orphan")).toBe(false);
    expect(numbers.get("b")).toBe(2);
  });

  test("queued annotations continue the resolved count (no second number 1)", () => {
    const numbers = numberAnnotations(
      [
        { id: "a", resolved: true },
        { id: "b", resolved: true },
      ],
      [{ id: "q1" }, { id: "q2" }],
    );
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
    expect(numbers.get("q1")).toBe(3);
    expect(numbers.get("q2")).toBe(4);
  });

  test("a queued id that already resolved keeps its resolved number (no dup)", () => {
    // Between a POST landing and the queue being filtered, the same id can be
    // in both lists; the resolved form wins.
    const numbers = numberAnnotations([{ id: "a", resolved: true }], [{ id: "a" }, { id: "b" }]);
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
  });
});
