import { describe, expect, test } from "bun:test";
import { bridgeBox, type BridgeRect } from "../client/chrome/bridge-box.ts";

/**
 * `bridgeBox` is the pure half of the tab-strip effect (plan 04, M0.1): given
 * the active tab's rect, the outer strip's rect, and whether the tab is the
 * first in its group, it returns the box of the bridge that makes the active
 * tab and the header below read as one continuous surface.
 *
 * The DOM-reading effect is brittle to test first; this is the pure geometry
 * that carries the load-bearing claims, driven here with rect literals.
 */

const rect = (left: number, top: number, width: number, bottom: number): BridgeRect => ({
  left,
  top,
  width,
  bottom,
});

describe("bridgeBox", () => {
  test("non-first tab: left/width/top derived from the two rects", () => {
    const strip = rect(10, 0, 1000, 46);
    const tab = rect(100, 8, 80, 40);

    const box = bridgeBox(tab, strip, false);

    // left is the tab's left in the strip's own frame, with no compensation:
    // a non-first tab's left hairline is its own border-l INSIDE its box.
    expect(box.left).toBe(90);
    // width covers the tab plus the right seam only - the next tab's border-l
    // (or the frame's border-r) sits 1px outside the tab's box.
    expect(box.width).toBe(81);
    // top is the tab's bottom edge in the strip's frame: from there down to
    // the strip's border is the moat the bridge fills.
    expect(box.top).toBe(40);
  });

  test("group-first tab: the 1px first:border-l-0 compensation lands on both left and width", () => {
    const strip = rect(10, 0, 1000, 46);
    const tab = rect(100, 8, 80, 40);

    const box = bridgeBox(tab, strip, true);

    // The group's first tab drops its own border-l (first:border-l-0), so its
    // left edge IS the frame's border 1px outside the box. left subtracts that
    // 1px so the bridge covers the frame border, not the tab's inset.
    expect(box.left).toBe(89);
    // width adds the left frame border back (1) on top of the right seam (1).
    expect(box.width).toBe(82);
    expect(box.top).toBe(40);
  });

  test("mid-scroll tab whose rect starts left of the strip origin goes negative", () => {
    const strip = rect(0, 0, 1000, 46);
    // A tab scrolled partly off the strip's left edge - its rect left is
    // negative. The bridge tracks the tab wherever it sits.
    const tab = rect(-50, 8, 80, 40);

    const box = bridgeBox(tab, strip, false);

    expect(box.left).toBe(-50);
    expect(box.width).toBe(81);
    expect(box.top).toBe(40);
  });

  test("the strip's own origin offsets every coordinate, not just left", () => {
    // A strip not pinned to (0,0): top offsets the bridge's vertical position,
    // left offsets its horizontal. Both rects are in viewport coordinates from
    // getBoundingClientRect, so the strip's own origin is subtracted out.
    const strip = rect(200, 300, 1000, 46);
    const tab = rect(300, 308, 80, 340);

    const box = bridgeBox(tab, strip, false);

    expect(box.left).toBe(100);
    expect(box.top).toBe(40);
  });
});
