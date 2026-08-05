import { describe, expect, test } from "bun:test";
import { createStatus, type CreateTurnEntry } from "../client/chrome/hub.ts";

const entry = (overrides: Partial<CreateTurnEntry> = {}): CreateTurnEntry => ({
  artifact: "/p/.lucid/x.html",
  submittedAt: 1000,
  lastProgressAt: null,
  lastProgressElapsedMs: null,
  failure: null,
  ...overrides,
});

const NOW = 20_000;

describe("createStatus", () => {
  test("authoring: submitted, hub accepted, progress is recent", () => {
    expect(createStatus(entry({ submittedAt: 9000, lastProgressAt: 9500 }), NOW)).toBe("authoring");
  });

  test("authoring: just submitted, no progress yet but within the arming window", () => {
    expect(createStatus(entry({ submittedAt: 19_000, lastProgressAt: null }), NOW)).toBe(
      "authoring",
    );
  });

  test("silent: no progress past the arming window", () => {
    expect(createStatus(entry({ submittedAt: 1000, lastProgressAt: 2000 }), NOW)).toBe("silent");
  });

  test("silent: progress stopped reporting past the window", () => {
    expect(
      createStatus(
        entry({ submittedAt: 1000, lastProgressAt: 2000, lastProgressElapsedMs: 5000 }),
        NOW,
      ),
    ).toBe("silent");
  });

  test("failed: a failure frame carries the reason", () => {
    expect(
      createStatus(
        entry({ failure: { artifact: "/p/.lucid/x.html", code: 1, tail: "boom" } }),
        NOW,
      ),
    ).toBe("failed");
  });

  test("failed wins over silent (a failure frame is a verdict, not a timeout)", () => {
    expect(
      createStatus(
        entry({
          submittedAt: 1000,
          lastProgressAt: 2000,
          failure: { artifact: "/p/.lucid/x.html", code: 1, tail: "boom" },
        }),
        NOW,
      ),
    ).toBe("failed");
  });

  test("a progress frame refreshes the arming window (progress recent → authoring, not silent)", () => {
    expect(createStatus(entry({ submittedAt: 1000, lastProgressAt: NOW - 1000 }), NOW)).toBe(
      "authoring",
    );
  });
});
