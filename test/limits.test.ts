import { describe, expect, test } from "bun:test";
import { detectUsageLimit } from "../src/launch/limits.ts";

describe("detectUsageLimit", () => {
  test("names codex's wall from its own last words", () => {
    const out = [
      "user",
      "Write a document.",
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 29th, 2026 12:02 AM.",
    ].join("\n");
    expect(detectUsageLimit(out)).toBe("usage-limit");
  });

  test("returns the matched pattern's identifier, never the harness's own words", () => {
    // The line that matched is harness output: whatever else it shares a line
    // with travels with it, and both consumers put it in a retained record.
    const out = [
      "user",
      "Write a document.",
      "ERROR: You've hit your usage limit. Working on ACQUISITION-OF-NORTHWIND, try again at Jul 29th.",
    ].join("\n");
    expect(detectUsageLimit(out)).toBe("usage-limit");
  });

  test("names claude code's session limit", () => {
    expect(detectUsageLimit("You've hit your session limit · resets 6:30pm")).toBe("session-limit");
  });

  test("names a google-family quota error (pi's default provider)", () => {
    expect(detectUsageLimit("Error: RESOURCE_EXHAUSTED: Quota exceeded for model")).toBe("quota");
  });

  test("a clean exit or an unrelated error is NOT a usage wall", () => {
    expect(detectUsageLimit("wrote /tmp/x.html\nopened for review")).toBeNull();
    expect(detectUsageLimit("Error: ENOENT no such file")).toBeNull();
    // A transient rate limit retries on its own - it must not read as a wall.
    expect(detectUsageLimit("429 rate limit, retrying in 2s")).toBeNull();
  });
});
