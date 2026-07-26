import { describe, expect, test } from "bun:test";
import { handleize, parseTitle } from "../src/core/title.ts";

/**
 * An artifact's own name. The shell puts `<title>` on a tab, so both halves
 * are pure: what a document is called, and the filename that title implies.
 */

describe("parseTitle", () => {
  test("reads the head's title, decoding entities and collapsing space", () => {
    expect(parseTitle("<html><head><title>Rollout  &amp;\n  rollback</title>")).toBe(
      "Rollout & rollback",
    );
  });

  test("a document with no usable title has none (the filename stands in)", () => {
    expect(parseTitle("<html><head><meta charset=utf-8></head>")).toBeNull();
    expect(parseTitle("<title>   </title>")).toBeNull();
  });

  test("control characters never reach the listing", () => {
    const withControls = `<title>Plan${String.fromCharCode(7)} v2${String.fromCharCode(127)}</title>`;
    expect(parseTitle(withControls)).toBe("Plan v2");
  });

  test("attributes on the tag do not defeat it", () => {
    expect(parseTitle('<title data-x="1">Units that got away</title>')).toBe("Units that got away");
  });

  test("a runaway title is bounded", () => {
    expect((parseTitle(`<title>${"x".repeat(400)}</title>`) ?? "").length).toBe(120);
  });
});

describe("handleize", () => {
  test("a title becomes the filename a human would have typed", () => {
    expect(handleize("Rollout plan for the billing service")).toBe(
      "rollout-plan-for-the-billing-service",
    );
    expect(handleize("Ye Olde 'Shoppe' - v2!")).toBe("ye-olde-shoppe-v2");
  });

  test("accents fold rather than vanish", () => {
    expect(handleize("Café notes")).toBe("cafe-notes");
  });

  test("a title with nothing usable yields nothing, not a stray dash", () => {
    expect(handleize("🎉🎉")).toBe("");
    expect(handleize("---")).toBe("");
  });

  test("the result always fits the create route's own name rule", () => {
    const long = handleize("word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(75);
    expect(long.endsWith("-")).toBe(false);
    expect(`${long}.html`).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.html$/);
  });
});
