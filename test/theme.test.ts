import { describe, expect, test } from "bun:test";
import { THEME_TOKENS } from "../src/core/palette.ts";
import { themeReadiness, themeWarning } from "../src/core/theme.ts";

/**
 * The viewer's light/dark choice reaches an artifact only through the standard
 * tokens. This is the check that says so at author time instead of leaving a
 * human to discover one document that stayed bright.
 */

const compliant = `<!doctype html>
<html><head><style>
  :root { --paper: #faf6ec; --ink: #211d15; --accent: #7b6228; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #211d15; --ink: #ece3cf; --accent: #d9bd7a; }
  }
  body { background: var(--paper); color: var(--ink); }
</style></head><body><h1>Plan</h1></body></html>`;

describe("themeReadiness", () => {
  test("a compliant artifact warns about nothing", () => {
    const r = themeReadiness(compliant);
    expect(r.hasDarkBlock).toBe(true);
    expect(r.usesTokens).toBe(true);
    expect(r.hardcoded).toEqual([]);
    expect(themeWarning(r)).toBeUndefined();
  });

  test("a literal in a token DECLARATION is where it belongs", () => {
    // Every color in the compliant fixture is a token value, and none of them
    // may be reported - otherwise the check fires on correct artifacts and gets
    // ignored, which is worse than not having it.
    expect(themeReadiness(":root { --paper: #faf6ec; }").hardcoded).toEqual([]);
  });

  test("a literal used directly is what a theme switch cannot reach", () => {
    const r = themeReadiness("body { background: #ffffff; color: rgb(20, 20, 20); }");
    expect(r.hardcoded).toEqual(["#ffffff", "rgb(20, 20, 20)"]);
    expect(themeWarning(r)).toContain("#ffffff");
  });

  test("the same literal twice is one finding", () => {
    const r = themeReadiness("a { color: #FFF; } b { color: #fff; }");
    expect(r.hardcoded).toHaveLength(1);
  });

  test("script payloads and comments are not stylesheets", () => {
    // Chart data and commented-out CSS carry color-shaped strings that nothing
    // renders; reporting them would train the author to ignore the warning.
    const html = `<script>const series = ["#ff0000", "#00ff00"];</script>
      <!-- body { color: #123456 } -->
      <style>:root { --ink: #211d15; } @media (prefers-color-scheme: dark) { :root { --ink: #eee; } }</style>`;
    expect(themeReadiness(html).hardcoded).toEqual([]);
  });

  test("no dark palette is named as such", () => {
    const r = themeReadiness(":root { --paper: #faf6ec; } body { background: var(--paper); }");
    expect(r.hasDarkBlock).toBe(false);
    expect(themeWarning(r)).toContain("no dark palette");
  });

  test("an artifact driven by data-lucid-theme counts as dark-ready", () => {
    // Lucid sets that attribute itself, so an artifact keyed on it is following
    // the viewer directly rather than the OS.
    const r = themeReadiness(
      ':root { --ink: #211d15; } :root[data-lucid-theme="dark"] { --ink: #ece3cf; }',
    );
    expect(r.hasDarkBlock).toBe(true);
    expect(themeWarning(r)).toBeUndefined();
  });

  test("the warning names the tokens to route through", () => {
    const r = themeReadiness("body { color: #000; }");
    const message = themeWarning(r) ?? "";
    expect(message).toContain(THEME_TOKENS[0]);
    expect(message).toContain("prefers-color-scheme: dark");
  });

  test("a long list is truncated with a count, not printed whole", () => {
    const css = ["#111", "#222", "#333", "#444", "#555"]
      .map((c, i) => `.c${i} { color: ${c}; }`)
      .join("\n");
    const message = themeWarning(themeReadiness(css)) ?? "";
    expect(message).toContain("5 hardcoded colors");
    expect(message).toContain("+2 more");
  });
});
