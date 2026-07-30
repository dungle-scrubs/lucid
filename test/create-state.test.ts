import { describe, expect, test } from "bun:test";
import { noteCreateFailed, noteCreateProgress, forgetCreate } from "../client/chrome/hub.ts";

/**
 * The create dialog's state transitions (plan 07, M2.1 - adversarial review of
 * #90). The dialog may only state what the hub told it, so the store's job is
 * to make stale claims unreachable: a heartbeat for an artifact invalidates a
 * FAILURE for that artifact, a failure invalidates the heartbeat, and starting
 * a turn forgets both. Every rule is keyed - one artifact's news must never
 * speak for another's.
 */

const frame = (elapsedMs = 2000) => ({ trace: "abcdef0123456789", elapsedMs, at: 1000 });
const failure = { artifact: "/p/.lucid/x.html", tail: "the old failure tail" };

describe("a heartbeat invalidates a stale failure for the SAME artifact", () => {
  test("a retry of a previously failed artifact is not reported as failed", () => {
    const before = { createFailed: failure, createProgress: {} };
    const after = noteCreateProgress(before, "/p/.lucid/x.html", frame());
    expect(after.createFailed).toBeNull();
    expect(after.createProgress["/p/.lucid/x.html"]).toBeDefined();
  });

  test("a heartbeat for a DIFFERENT artifact leaves the failure standing", () => {
    const before = { createFailed: failure, createProgress: {} };
    const after = noteCreateProgress(before, "/p/.lucid/other.html", frame());
    expect(after.createFailed).toEqual(failure);
  });
});

describe("a failure invalidates the heartbeat for that artifact", () => {
  test("the dead turn's last heartbeat is dropped, so nothing arms silence from it", () => {
    const before = {
      createFailed: null,
      createProgress: { "/p/.lucid/x.html": frame(), "/p/.lucid/y.html": frame() },
    };
    const after = noteCreateFailed(before, failure);
    expect(after.createProgress["/p/.lucid/x.html"]).toBeUndefined();
    expect(after.createProgress["/p/.lucid/y.html"]).toBeDefined();
  });
});

describe("starting a turn forgets both - the retry begins with no history", () => {
  test("a stale entry cannot arm silence at 0:00 on a fresh submit", () => {
    const before = {
      createFailed: failure,
      createProgress: { "/p/.lucid/x.html": frame(480_000) },
    };
    const after = forgetCreate(before, "/p/.lucid/x.html");
    expect(after.createFailed).toBeNull();
    expect(after.createProgress["/p/.lucid/x.html"]).toBeUndefined();
  });

  test("another artifact's live turn survives", () => {
    const before = {
      createFailed: null,
      createProgress: { "/p/.lucid/x.html": frame(), "/p/.lucid/live.html": frame() },
    };
    const after = forgetCreate(before, "/p/.lucid/x.html");
    expect(after.createProgress["/p/.lucid/live.html"]).toBeDefined();
  });
});
