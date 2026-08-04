import { describe, expect, test } from "bun:test";
import {
  computeMarkers,
  enforceMarkerRectBudget,
  MAX_MARKER_RECTS,
  type MarkerInput,
  type Rect,
} from "../client/overlay/markers.ts";

const rect = (left: number, top = 0): Rect => ({ left, top, width: 10, height: 10 });

const input = (overrides: Partial<MarkerInput> = {}): MarkerInput => ({
  committed: [],
  decisions: [],
  pending: [],
  queued: [],
  ...overrides,
});

describe("overlay marker computation", () => {
  test("numbers committed and queued continuously; decisions and pending stay unnumbered", () => {
    const markers = computeMarkers(
      input({
        decisions: [[rect(0)], [rect(0)]],
        committed: [
          { id: "c1", paints: true, targets: [[rect(100)]] },
          { id: "c2", paints: true, targets: [[rect(200)]] },
        ],
        queued: [{ id: "q1", targets: [[rect(300)]] }],
        pending: [[rect(400)]],
      }),
    );
    expect(markers.map((marker) => [marker.state, marker.index])).toEqual([
      ["decision", 0],
      ["decision", 0],
      ["committed", 1],
      ["committed", 2],
      ["queued", 3],
      ["pending", 0],
    ]);
  });

  test("a hidden committed annotation keeps its number in the count but paints no marker", () => {
    // The number belongs to the record: hiding #1 must not renumber #2's badge.
    const markers = computeMarkers(
      input({
        committed: [
          { id: "c1", paints: false, targets: [[rect(100)]] },
          { id: "c2", paints: true, targets: [[rect(200)]] },
        ],
      }),
    );
    expect(markers.map((marker) => [marker.id, marker.index])).toEqual([["c2", 2]]);
  });

  test("the badge lands on the first resolving target of a multi-target annotation", () => {
    const markers = computeMarkers(
      input({
        committed: [{ id: "c1", paints: true, targets: [[], [rect(200)]] }],
      }),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.index).toBe(1);
  });

  test("a secondary resolving target of one annotation carries no badge", () => {
    const markers = computeMarkers(
      input({
        committed: [{ id: "c1", paints: true, targets: [[rect(10)], [rect(20)]] }],
      }),
    );
    expect(markers.map((marker) => marker.index)).toEqual([1, 0]);
    // both share the item id so focus lights every spot
    expect(markers.every((marker) => marker.id === "c1")).toBe(true);
  });

  test("the corner cascade offsets badges that would overlap on one corner", () => {
    const markers = computeMarkers(
      input({
        committed: [
          { id: "c1", paints: true, targets: [[rect(50, 50)]] },
          { id: "c2", paints: true, targets: [[rect(50, 50)]] },
        ],
      }),
    );
    expect(markers.map((marker) => marker.stackIndex)).toEqual([0, 1]);
  });

  test("an unnumbered marker never joins the cascade", () => {
    // A pending spot (index 0) on the same corner as a badge must not advance it.
    const markers = computeMarkers(
      input({
        committed: [{ id: "c1", paints: true, targets: [[rect(50, 50)]] }],
        pending: [[rect(50, 50)]],
      }),
    );
    expect(markers.map((marker) => [marker.state, marker.stackIndex])).toEqual([
      ["committed", 0],
      ["pending", 0],
    ]);
  });
});

describe("overlay marker rect budget", () => {
  const filled = (count: number): Rect[] =>
    Array.from({ length: count }, (_, index) => rect(index));

  test(`the boundary is exclusive: ${MAX_MARKER_RECTS} renders, one more drops every marker`, () => {
    const oneBelow = computeMarkers(
      input({ committed: [{ id: "c", paints: true, targets: [filled(MAX_MARKER_RECTS - 1)] }] }),
    );
    const atLimit = computeMarkers(
      input({ committed: [{ id: "c", paints: true, targets: [filled(MAX_MARKER_RECTS)] }] }),
    );
    const overLimit = computeMarkers(
      input({ committed: [{ id: "c", paints: true, targets: [filled(MAX_MARKER_RECTS + 1)] }] }),
    );
    expect(enforceMarkerRectBudget(oneBelow).budgetExceeded).toBe(false);
    expect(enforceMarkerRectBudget(atLimit).budgetExceeded).toBe(false);
    expect(enforceMarkerRectBudget(overLimit).budgetExceeded).toBe(true);
  });

  test("a budget drop drops every marker rather than painting a partial set", () => {
    const overLimit = computeMarkers(
      input({
        committed: [
          { id: "c1", paints: true, targets: [filled(MAX_MARKER_RECTS)] },
          { id: "c2", paints: true, targets: [[rect(0)]] },
        ],
      }),
    );
    const result = enforceMarkerRectBudget(overLimit);
    expect(result.budgetExceeded).toBe(true);
    expect(result.markers).toEqual([]);
  });

  test("empty input renders nothing and is distinguishable from a budget drop", () => {
    const empty = enforceMarkerRectBudget(computeMarkers(input()));
    expect(empty.markers).toEqual([]);
    expect(empty.budgetExceeded).toBe(false);
    const dropped = enforceMarkerRectBudget(
      computeMarkers(
        input({ committed: [{ id: "c", paints: true, targets: [filled(MAX_MARKER_RECTS + 1)] }] }),
      ),
    );
    expect(dropped.markers).toEqual([]);
    expect(dropped.budgetExceeded).toBe(true);
  });

  test("rects accumulate across markers, not per marker", () => {
    // Two markers whose rects sum past the budget drop, even though each is under it.
    const result = enforceMarkerRectBudget(
      computeMarkers(
        input({
          committed: [
            { id: "c1", paints: true, targets: [filled(300)] },
            { id: "c2", paints: true, targets: [filled(300)] },
          ],
        }),
      ),
    );
    expect(result.budgetExceeded).toBe(true);
  });
});
