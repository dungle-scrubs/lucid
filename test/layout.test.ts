import { describe, expect, test } from "bun:test";
import { visibleTabKeys } from "../client/chrome/hub.ts";
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

describe("visibleTabKeys", () => {
  const rows = [
    { artifact: "/dev/sdlc/a.html", project: "/dev/sdlc" },
    { artifact: "/dev/tether/b.html", project: "/dev/tether" },
  ];
  const keys = ["/dev/sdlc/a.html", "/dev/tether/b.html"];

  test("no scope shows every open tab", () => {
    expect(visibleTabKeys(keys, rows, null, keys[0] ?? null)).toEqual(keys);
  });

  test("a scope hides the other projects' tabs", () => {
    expect(visibleTabKeys(keys, rows, "/dev/sdlc", "/dev/sdlc/a.html")).toEqual([
      "/dev/sdlc/a.html",
    ]);
  });

  // The dead end this guards: the scope said sdlc while the ACTIVE tab was a
  // tether artifact, so the strip filtered away the only tab that could have
  // changed it - a scope badge over a foreign artifact and nothing to click.
  test("the active tab survives a scope it does not belong to", () => {
    const visible = visibleTabKeys(keys, rows, "/dev/sdlc", "/dev/tether/b.html");
    expect(visible).toContain("/dev/tether/b.html");
    expect(visible).toContain("/dev/sdlc/a.html");
  });

  test("a tab the listing has not named yet stays visible", () => {
    const withUnknown = [...keys, "/dev/new/c.html"];
    expect(visibleTabKeys(withUnknown, rows, "/dev/sdlc", "/dev/sdlc/a.html")).toContain(
      "/dev/new/c.html",
    );
  });

  test("no active tab is not treated as one", () => {
    expect(visibleTabKeys(keys, rows, "/dev/sdlc", null)).toEqual(["/dev/sdlc/a.html"]);
  });
});
