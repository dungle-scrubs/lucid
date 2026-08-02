import { describe, expect, test } from "bun:test";
import { sectionIdOf, urlTransform } from "../client/chrome/ui/markdown.tsx";

/**
 * `lucid:` hrefs in agent prose.
 *
 * Regression: only `lucid:section/<id>` was recognized, and everything else
 * fell through to an external `<a target="_blank">`. Agents write the short
 * `lucid:<id>` form constantly, so every one of those links opened a browser
 * window on an unhandled protocol instead of scrolling the artifact.
 */
describe("sectionIdOf", () => {
  test("reads the documented long form", () => {
    expect(sectionIdOf("lucid:section/ms-16")).toBe("ms-16");
  });

  test("reads the short form agents actually write", () => {
    expect(sectionIdOf("lucid:ms-16")).toBe("ms-16");
  });

  test("is not fooled by ordinary links", () => {
    expect(sectionIdOf("https://example.com/section/ms-16")).toBeNull();
    expect(sectionIdOf("#ms-16")).toBeNull();
    expect(sectionIdOf(undefined)).toBeNull();
  });

  test("refuses a `lucid:` href with more structure than one id", () => {
    // Not a permalink shape - and the renderer must show it as text rather
    // than guess, because handing it to the browser is what caused the bug.
    expect(sectionIdOf("lucid:section/a/b")).toBeNull();
    expect(sectionIdOf("lucid:a/b")).toBeNull();
    expect(sectionIdOf("lucid:")).toBeNull();
    expect(sectionIdOf("lucid:section/")).toBeNull();
  });
});

describe("urlTransform", () => {
  test("lets every `lucid:` href through the sanitizer", () => {
    // The sanitizer runs before the link component, so a blanked href would
    // reach it as undefined and be indistinguishable from a bare link.
    expect(urlTransform("lucid:ms-16")).toBe("lucid:ms-16");
    expect(urlTransform("lucid:section/ms-16")).toBe("lucid:section/ms-16");
  });

  test("still sanitizes dangerous schemes", () => {
    expect(urlTransform("javascript:alert(1)")).toBe("");
    expect(urlTransform("https://example.com")).toBe("https://example.com");
  });
});
