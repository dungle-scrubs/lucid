import { describe, expect, test } from "bun:test";
import {
  sanitizeRenderSnapshot,
  type RawRenderSnapshot,
} from "../client/overlay/render-snapshot.ts";

const raw = (overrides: Partial<RawRenderSnapshot> = {}): RawRenderSnapshot => ({
  focusedId: null,
  hoverRect: null,
  markers: [],
  sectionPulse: 0,
  sectionRect: null,
  ...overrides,
});

const marker = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "m1",
  index: 1,
  rects: [{ height: 4, left: 1, top: 2, width: 3 }],
  stackIndex: 0,
  state: "committed",
  ...overrides,
});

describe("render-snapshot sanitizer", () => {
  test("passes valid markers through, validated and ordered", () => {
    const snapshot = sanitizeRenderSnapshot(
      raw({ markers: [marker({ id: "a" }), marker({ id: "b", state: "queued" })] }),
    );
    expect(snapshot.markers.map((entry) => [entry.id, entry.state])).toEqual([
      ["a", "committed"],
      ["b", "queued"],
    ]);
  });

  test("drops a marker whose state is not one of the four", () => {
    const snapshot = sanitizeRenderSnapshot(
      raw({ markers: [marker({ id: "keep" }), marker({ id: "drop", state: "forged" })] }),
    );
    expect(snapshot.markers.map((entry) => entry.id)).toEqual(["keep"]);
  });

  test("truncates the id to 256 chars and the index/stackIndex to integers", () => {
    const snapshot = sanitizeRenderSnapshot(
      raw({
        markers: [marker({ id: "x".repeat(300), index: 3.9, stackIndex: 2.7 })],
      }),
    );
    expect(snapshot.markers[0]?.id).toHaveLength(256);
    expect(snapshot.markers[0]?.index).toBe(3);
    expect(snapshot.markers[0]?.stackIndex).toBe(2);
  });

  test("caps rects per marker and drops non-rect entries", () => {
    const rects = Array.from({ length: 70 }, (_, index) => ({
      height: 1,
      left: index,
      top: 0,
      width: 1,
    }));
    const snapshot = sanitizeRenderSnapshot(
      raw({
        markers: [
          marker({
            rects: [...rects, { left: "no" }, null],
          }),
        ],
      }),
    );
    // 64 kept (the cap), the non-rect entries dropped - not 70, not 72
    expect(snapshot.markers[0]?.rects).toHaveLength(64);
  });

  test("coerces non-finite geometry to zero rather than rendering it raw", () => {
    const snapshot = sanitizeRenderSnapshot(
      raw({
        hoverRect: { height: 4, left: 1, top: 2, width: 3 },
        markers: [marker({ rects: [{ height: Number.NaN, left: 1, top: 2, width: 3 }] })],
        sectionRect: { left: Number.POSITIVE_INFINITY, top: 0, width: 1, height: 1 },
      }),
    );
    expect(snapshot.hoverRect).toEqual({ height: 4, left: 1, top: 2, width: 3 });
    expect(snapshot.markers[0]?.rects).toEqual([{ height: 0, left: 1, top: 2, width: 3 }]);
    expect(snapshot.sectionRect).toEqual({ height: 1, left: 0, top: 0, width: 1 });
  });

  test("focusedId is null unless it is a string, and truncated to 256", () => {
    expect(sanitizeRenderSnapshot(raw({ focusedId: 42 })).focusedId).toBeNull();
    expect(sanitizeRenderSnapshot(raw({ focusedId: "x".repeat(300) })).focusedId).toHaveLength(256);
  });

  test("non-array markers and non-finite section pulse degrade safely", () => {
    const snapshot = sanitizeRenderSnapshot(
      raw({ markers: "not-an-array", sectionPulse: Number.NaN }),
    );
    expect(snapshot.markers).toEqual([]);
    expect(snapshot.sectionPulse).toBe(0);
  });

  test("a hostile marker list over the rect budget drops every marker", () => {
    // The per-marker cap (64) means a single marker cannot exceed the budget; it
    // is crossed across markers, and crossing it drops the whole set.
    const fullMarker = (): Record<string, unknown> =>
      marker({
        rects: Array.from({ length: 64 }, (_, index) => ({
          height: 1,
          left: index,
          top: 0,
          width: 1,
        })),
      });
    const snapshot = sanitizeRenderSnapshot(
      raw({ markers: Array.from({ length: 9 }, fullMarker) }), // 9 * 64 = 576 > 512
    );
    expect(snapshot.markers).toEqual([]);
  });
});
