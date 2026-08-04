import { describe, expect, test } from "bun:test";
import { WORKING_GRACE_MS, workingClock } from "../client/chrome/working.ts";
import { sanitizeBlocked } from "../src/core/progress.ts";

/**
 * The rule both the thread line and the surface chip read, so the two can never
 * disagree about whether one turn is still working.
 */
describe("the working clock", () => {
  const since = "2026-01-01T00:00:00Z";
  const at = (ms: number): number => new Date(since).getTime() + ms;

  test("measures the wait from delivery and liveness from the last ack", () => {
    // Twenty minutes in, but heard from a minute ago: a long turn that is
    // narrating its phases is working, however long the human has waited.
    const c = workingClock({ since, heardAt: "2026-01-01T00:19:00Z" }, at(20 * 60_000));
    expect(c.mm).toBe(20);
    expect(c.stale).toBe(false);
    expect(c.quietMs).toBe(60_000);
  });

  test("goes stale on silence, not on duration", () => {
    // Delivered two minutes ago, silent since the first ack: the turn's process
    // died early, and no amount of waiting will produce the update it promised.
    const dead = workingClock({ since, heardAt: since }, at(WORKING_GRACE_MS + 1));
    expect(dead.stale).toBe(true);
    // The boundary itself is stale - the threshold is "this long with nothing".
    expect(workingClock({ since, heardAt: since }, at(WORKING_GRACE_MS)).stale).toBe(true);
    expect(workingClock({ since, heardAt: since }, at(WORKING_GRACE_MS - 1)).stale).toBe(false);
  });

  test("falls back to `since` when the server is too old to report heardAt", () => {
    // Reproduces the previous behaviour exactly rather than calling every turn
    // fresh - an omitted field must not read as "just heard from".
    expect(workingClock({ since }, at(WORKING_GRACE_MS + 1)).stale).toBe(true);
    expect(workingClock({ since }, at(60_000)).stale).toBe(false);
  });

  test("clamps a clock skewed into the future rather than reporting negative time", () => {
    const c = workingClock({ since, heardAt: since }, at(-5_000));
    expect(c.elapsedMs).toBe(0);
    expect(c.mm).toBe(0);
    expect(c.ss).toBe("00");
    expect(c.stale).toBe(false);
  });
});

describe("the blocked report", () => {
  test("keeps a one-line reason and drops what is not one", () => {
    expect(sanitizeBlocked("  needs the WebFetch\n  permission  ")).toBe(
      "needs the WebFetch permission",
    );
    expect(sanitizeBlocked("")).toBeUndefined();
    expect(sanitizeBlocked("   ")).toBeUndefined();
    expect(sanitizeBlocked(undefined)).toBeUndefined();
    expect(sanitizeBlocked(42)).toBeUndefined();
    // Bounded like a progress label: it rides every ack and lives in the log.
    expect(sanitizeBlocked("x".repeat(500))?.length).toBe(200);
  });
});
