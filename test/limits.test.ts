import { describe, expect, test } from "bun:test";
import { TURN_END_CODE, TURN_END_REASONS } from "../src/core/events.ts";
import { detectAuthFailure, detectUsageLimit } from "../src/launch/limits.ts";
import { classifyTurnFailure } from "../src/launch/turn.ts";

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

  test("names claude code's weekly limit", () => {
    expect(detectUsageLimit("You've hit your weekly limit · resets 2am (Asia/Bangkok)")).toBe(
      "weekly-limit",
    );
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

describe("detectAuthFailure", () => {
  test("recognises each harness's way of saying it cannot authenticate", () => {
    // Claude Code.
    expect(detectAuthFailure("Failed to authenticate: OAuth session expired")).toBe("expired");
    expect(detectAuthFailure("OAuth session expired and could not be refreshed")).toBe("expired");
    expect(detectAuthFailure("Not logged in. Please run /login")).toBe("not-logged-in");
    expect(detectAuthFailure("Invalid API key provided")).toBe("invalid-key");
    // Codex.
    expect(detectAuthFailure("Run codex login to continue")).toBe("not-logged-in");
    expect(detectAuthFailure("HTTP 401 Unauthorized")).toBe("expired");
  });

  test("returns the KIND, never the harness's line", () => {
    // The line that matched carries whatever else the harness printed on it -
    // a path, a customer name, a prompt fragment. A record gets the
    // identifier; the dialog shows the words through the `tail` it already
    // carries (D-005).
    const kind = detectAuthFailure(
      "Failed to authenticate while working on ACQUISITION-OF-NORTHWIND",
    );
    expect(kind).toBe("expired");
    expect(kind).not.toContain("NORTHWIND");
  });

  test("scans bottom-up, so the LAST thing a dying turn said wins", () => {
    const output = ["Not logged in. Please run /login", "Invalid API key provided"].join("\n");
    expect(detectAuthFailure(output)).toBe("invalid-key");
  });

  test("ordinary output is not an auth failure", () => {
    expect(detectAuthFailure("wrote plan.html\nall good")).toBeNull();
    // A usage wall is a different wall - it must not read as an auth problem,
    // because the remedy is the opposite (wait vs re-auth).
    expect(detectAuthFailure("You've hit your usage limit")).toBeNull();
  });
});

describe("classifyTurnFailure", () => {
  test("an auth-walled turn is recorded as one, not as a bare failure", () => {
    // The divergence this closes: the create path detected auth walls and the
    // attend path did not, so an artifact whose delivery died on the detached
    // hub's missing credentials ended with `reason: "failed"` and no code at
    // all - the one failure that no amount of logging in again can fix, with
    // nothing in the record to say so.
    const failure = classifyTurnFailure("Failed to authenticate: OAuth session expired");
    expect(failure.authFailure).toBe("expired");
    expect(failure.reason).toBe("failed");
    expect(failure.code).toBe("auth_expired");
  });

  test("a usage wall outranks an auth wall in the record", () => {
    // A harness over its budget will not authenticate its way back in, so the
    // wall the human can do nothing about is the one the turn record names -
    // while both kinds stay available to the create dialog, which reports
    // them as separate facts with separate remedies.
    const failure = classifyTurnFailure(
      ["Not logged in. Please run /login", "You've hit your weekly limit · resets 2am"].join("\n"),
    );
    expect(failure.reason).toBe("usage_limit");
    expect(failure.code).toBe("weekly_limit");
    expect(failure.usageLimit).toBe("weekly-limit");
    expect(failure.authFailure).toBe("not-logged-in");
  });

  test("output naming no wall carries no code", () => {
    const failure = classifyTurnFailure("Error: ENOENT no such file");
    expect(failure).toEqual({ usageLimit: null, authFailure: null, reason: "failed" });
  });

  test("every verdict fits the log's own reason set and code charset", () => {
    // The verdict goes straight into `agent_turn_ended`, whose reasons are a
    // closed set and whose code is refused rather than truncated. A kind that
    // maps to something the event layer rejects would silently drop the
    // terminator - the exact append that closes a working window.
    for (const output of [
      "You've hit your usage limit",
      "You've hit your session limit",
      "You've hit your weekly limit",
      "insufficient credits",
      "RESOURCE_EXHAUSTED",
      "Not logged in. Please run /login",
      "OAuth session expired",
      "Invalid API key provided",
      "nothing recognisable at all",
    ]) {
      const failure = classifyTurnFailure(output);
      expect(TURN_END_REASONS.has(failure.reason)).toBe(true);
      if (failure.code !== undefined) expect(TURN_END_CODE.test(failure.code)).toBe(true);
    }
  });
});
