import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_PALETTE, THEME_TOKENS, type ThemeToken } from "../src/core/palette.ts";

/**
 * The palette had four hand-mirrored copies and nothing checked that they still
 * agreed. Two of them cannot import the table: a stylesheet and a Markdown
 * skill. So they are read as text and compared against it here - a grep, not a
 * browser, so a value edited in one place and not the other is red in seconds.
 */

const REPO = join(import.meta.dirname, "..");

/** `--token: value;`, whatever padding the author aligned it with. A trailing
 *  `/* … *\/` note is theirs to keep. */
const declaredValue = (css: string, token: ThemeToken): string | undefined =>
  new RegExp(`${token}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

describe("the lucid-design skill teaches the palette the viewer applies", () => {
  const skill = readFileSync(join(REPO, "skills/lucid-design/SKILL.md"), "utf8");
  const fences = [...skill.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const blocks = {
    dark: fences.find((f) => f.includes("prefers-color-scheme: dark")) ?? "",
    light: fences.find((f) => f.trimStart().startsWith(":root")) ?? "",
  };

  for (const theme of ["light", "dark"] as const) {
    test(`the ${theme} block is the ${theme} table`, () => {
      expect(blocks[theme], `no ${theme} css block in the skill`).not.toBe("");
      for (const token of THEME_TOKENS) {
        expect(declaredValue(blocks[theme], token), token).toBe(THEME_PALETTE[theme][token]);
      }
    });
  }
});

describe("the chrome's artifact ground is the palette's paper", () => {
  // The chrome is Nord and the artifact is warm cream; this pair is the seam
  // between them, and it must be the ground artifacts actually assume.
  const styles = readFileSync(join(REPO, "client/chrome/styles.css"), "utf8");

  test("--color-surface and --color-surface-ink are the light paper and ink", () => {
    expect(/--color-surface:\s*([^;]+);/.exec(styles)?.[1]?.trim()).toBe(
      THEME_PALETTE.light["--paper"],
    );
    expect(/--color-surface-ink:\s*([^;]+);/.exec(styles)?.[1]?.trim()).toBe(
      THEME_PALETTE.light["--ink"],
    );
  });
});
