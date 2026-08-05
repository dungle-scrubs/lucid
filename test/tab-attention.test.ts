import { describe, expect, test } from "bun:test";
import {
  tabAttention,
  hubAttentionFor,
  type TabAttentionInputs,
  type HubRow,
} from "../client/chrome/attention.ts";

const hub = (overrides: Partial<HubRow> = {}): HubRow => ({
  lastEventSeq: 0,
  openQuestions: 0,
  working: false,
  ...overrides,
});

const own = { openQuestions: false, working: false };

const inputs = (overrides: Partial<TabAttentionInputs> = {}): TabAttentionInputs => ({
  active: false,
  hub: undefined,
  live: true,
  own,
  viewed: undefined,
  ...overrides,
});

describe("tabAttention", () => {
  test("a live tab unions the hub row with its own fold", () => {
    expect(
      tabAttention(
        inputs({
          live: true,
          hub: hub({ working: true }),
          own: { openQuestions: true, working: false },
        }),
      ).state,
    ).toBe("question");
    expect(
      tabAttention(
        inputs({
          live: true,
          hub: hub({ working: true }),
          own: { openQuestions: false, working: false },
        }),
      ).state,
    ).toBe("working");
    expect(
      tabAttention(
        inputs({
          live: true,
          hub: hub({ working: false }),
          own: { openQuestions: false, working: true },
        }),
      ).state,
    ).toBe("working");
  });

  test("an evicted tab reads the hub row alone (frozen store must not hold a stale dot)", () => {
    expect(
      tabAttention(
        inputs({
          live: false,
          hub: hub({ working: true }),
          own: { openQuestions: false, working: false },
        }),
      ).state,
    ).toBe("working");
    // own fold is ignored when evicted
    expect(
      tabAttention(
        inputs({
          live: false,
          hub: hub({ working: false }),
          own: { openQuestions: true, working: true },
        }),
      ).state,
    ).toBe("settled");
  });

  test("an evicted background tab still raises its question dot", () => {
    expect(tabAttention(inputs({ live: false, hub: hub({ openQuestions: 1 }) })).state).toBe(
      "question",
    );
  });

  test("the active tab is never unseen", () => {
    expect(
      tabAttention(inputs({ active: true, hub: hub({ lastEventSeq: 10 }), viewed: 5 })).state,
    ).toBe("settled");
  });

  test("unseen clears on activation, not on the change settling", () => {
    expect(
      tabAttention(inputs({ active: false, hub: hub({ lastEventSeq: 10 }), viewed: 5 })).state,
    ).toBe("finished-unseen");
    // activating clears it
    expect(
      tabAttention(inputs({ active: true, hub: hub({ lastEventSeq: 10 }), viewed: 5 })).state,
    ).toBe("settled");
  });

  test("a tab with no hub entry falls back to own fold when live, settled when evicted", () => {
    expect(
      tabAttention(
        inputs({ live: true, hub: undefined, own: { openQuestions: true, working: false } }),
      ).state,
    ).toBe("question");
    expect(
      tabAttention(
        inputs({ live: false, hub: undefined, own: { openQuestions: true, working: false } }),
      ).state,
    ).toBe("settled");
  });
});

describe("hubAttentionFor", () => {
  test("finds the attention row for an artifact key", () => {
    const sessions = [
      { artifact: "/p/a.md", id: "s1" },
      { artifact: "/p/b.md", id: "s2" },
    ];
    const attention = { s1: hub({ working: true }), s2: hub({ openQuestions: 1 }) };
    expect(hubAttentionFor(sessions, attention, "/p/a.md")).toEqual(hub({ working: true }));
    expect(hubAttentionFor(sessions, attention, "/p/b.md")).toEqual(hub({ openQuestions: 1 }));
  });

  test("returns undefined when the artifact has no session", () => {
    expect(hubAttentionFor([], {}, "/p/missing.md")).toBeUndefined();
    expect(
      hubAttentionFor([{ artifact: "/p/a.md", id: "s1" }], {}, "/p/missing.md"),
    ).toBeUndefined();
  });
});
