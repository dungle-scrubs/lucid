import { describe, expect, test } from "bun:test";
import { harnessKind, normalizeHarness } from "../src/core/harness.ts";
import { harnessHasLocalStore, harnessSupportsPresence } from "../src/core/presence.ts";
import type { SpawnRecipe } from "../src/launch/recipes.ts";
import { selectionArgs } from "../src/launch/selection.ts";

/**
 * The owner of "which harness is this" (`core/harness.ts`).
 *
 * Spelling-equivalence and the family test had five copies between them, and
 * one of them - the selection adapter's - had lost the `.trim()`. The rules
 * are tested here, where they live, rather than once per surface that asks.
 */

describe("normalizeHarness", () => {
  test("separator, case and surrounding whitespace are not identity", () => {
    expect(normalizeHarness("claude_code")).toBe("claude-code");
    expect(normalizeHarness("Claude-Code")).toBe("claude-code");
    expect(normalizeHarness("  claude_code \n")).toBe("claude-code");
  });

  test("an unknown harness is normalized, not judged", () => {
    expect(normalizeHarness(" Mystery_Box ")).toBe("mystery-box");
  });
});

describe("harnessKind", () => {
  test("claude-code and claude are one family, in every spelling", () => {
    for (const name of ["claude-code", "claude_code", "Claude-Code", " claude "]) {
      expect(harnessKind(name)).toBe("claude");
    }
  });

  test("codex and pi are their own families", () => {
    expect(harnessKind("codex")).toBe("codex");
    expect(harnessKind("  PI ")).toBe("pi");
  });

  test("a harness Lucid has no built-in knowledge of is undefined, never a guess", () => {
    expect(harnessKind("mystery")).toBeUndefined();
    expect(harnessKind("")).toBeUndefined();
    // Near misses stay misses: the set is closed, not a prefix match.
    expect(harnessKind("claude-code-2")).toBeUndefined();
  });
});

describe("the one rule reaches every surface that asks", () => {
  const CLAUDE: SpawnRecipe = { spawn: ["claude"], models: [{ id: "opus-5" }] };

  test("a whitespace-padded registry key gets its flags, not an error", () => {
    // The drift this PR closes: identity trimmed the key and flag lookup did
    // not, so a registry whose harness name carried a stray space canonicalized
    // for resume and then failed here - "Lucid knows no such flags for it"
    // about a harness Lucid ships.
    expect(selectionArgs(" claude_code ", CLAUDE, { model: "opus-5" })).toEqual([
      "--model",
      "opus-5",
    ]);
  });

  test("presence and store knowledge answer for the same family", () => {
    expect(harnessSupportsPresence(" Claude_Code ")).toBe(true);
    expect(harnessSupportsPresence("codex")).toBe(false);
    expect(harnessHasLocalStore(" Codex ")).toBe(true);
    expect(harnessHasLocalStore("pi")).toBe(false);
  });
});
