import { describe, expect, test } from "bun:test";
import { CHROME_MIN_WIDTH, defaultChromeWidth } from "../client/chrome/shell.ts";

/**
 * The review panel's starting width. A fraction of the window rather than a
 * fixed number, because the conversation is the other half of the review: one
 * pixel count that suits a laptop is a sliver on a 32" display and crowds the
 * artifact on a small one.
 */
describe("defaultChromeWidth", () => {
  test("takes about a third of the window", () => {
    expect(defaultChromeWidth(1728)).toBe(536);
    expect(defaultChromeWidth(1440)).toBe(446);
  });

  test("never starts below the width the divider can be dragged to", () => {
    // A default the human would have to fix before using is not a default.
    expect(defaultChromeWidth(800)).toBe(CHROME_MIN_WIDTH);
    expect(defaultChromeWidth(0)).toBe(CHROME_MIN_WIDTH);
  });

  test("stops widening on a big display, so the artifact keeps its measure", () => {
    // The panel is ABOUT the paper; past ~640px it starts eating the column
    // the reader is actually reading.
    expect(defaultChromeWidth(3840)).toBe(640);
    expect(defaultChromeWidth(5120)).toBe(640);
  });

  test("is monotonic - a wider window never yields a narrower panel", () => {
    let last = 0;
    for (let w = 600; w <= 4000; w += 137) {
      const got = defaultChromeWidth(w);
      expect(got).toBeGreaterThanOrEqual(last);
      last = got;
    }
  });
});
