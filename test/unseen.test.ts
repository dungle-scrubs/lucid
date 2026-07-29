import { beforeEach, describe, expect, test } from "bun:test";

/**
 * lastViewedSeq and unseen (plan 03, M3.2, D-025).
 *
 * Per-machine markers: activation records how far this machine has read each
 * artifact's log; growth past that mark while the tab is INACTIVE is
 * finished-unseen. Settling alone never clears it - only the human arriving
 * does - and a stored payload from before the marker existed reads as
 * all-SEEN, never as a wall of stale badges.
 */

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("isUnseen: the growth comparison", () => {
  test("growth past the recorded mark is unseen", async () => {
    const { isUnseen } = await import("../client/chrome/attention.ts");
    expect(isUnseen(7, 4)).toBe(true);
  });

  test("at or below the mark is seen", async () => {
    const { isUnseen } = await import("../client/chrome/attention.ts");
    expect(isUnseen(4, 4)).toBe(false);
    expect(isUnseen(3, 4)).toBe(false);
  });

  test("no recorded mark is SEEN - the upgrade rule, per tab", async () => {
    const { isUnseen } = await import("../client/chrome/attention.ts");
    expect(isUnseen(999, undefined)).toBe(false);
  });
});

describe("the persisted marker map", () => {
  test("readStoredTabs round-trips the viewed map", async () => {
    const { persistTabs, readStoredTabs } = await import("../client/chrome/shell.ts");
    persistTabs({ keys: ["a.html"], active: "a.html", viewed: { "a.html": 12 } });
    expect(readStoredTabs().viewed).toEqual({ "a.html": 12 });
  });

  test("a stored payload WITHOUT the map is all-seen, never all-unseen", async () => {
    const { readStoredTabs } = await import("../client/chrome/shell.ts");
    // The pre-M3.2 shape: keys and active only.
    localStorage.setItem("lucid.openTabs", JSON.stringify({ keys: ["a.html"], active: "a.html" }));
    const stored = readStoredTabs();
    expect(stored.viewed).toEqual({}); // empty map: isUnseen(_, undefined) = seen
  });

  test("recordViewed lands in the store for the strip to read", async () => {
    const { recordViewed } = await import("../client/chrome/shell.ts");
    const { useShell } = await import("../client/chrome/shell.ts");
    recordViewed("/p/a.html", 9);
    expect(useShell.getState().viewedSeq["/p/a.html"]).toBe(9);
  });
});

describe("the attention frame bumps ONLY the active tab's marker", () => {
  test("active tab tracks; inactive tabs keep their mark even when the agent settles", async () => {
    const { applyAttentionFrame } = await import("../client/chrome/hub.ts");
    const { useHub } = await import("../client/chrome/hub.ts");
    const { useShell, recordViewed } = await import("../client/chrome/shell.ts");

    // Two known sessions; the human is looking at A. B was read to seq 3.
    useHub.setState({
      sessions: [
        {
          artifact: "/frame/a.html",
          name: "a.html",
          lastSeen: "",
          id: "ida",
          hosted: false,
          project: "/frame",
        },
        {
          artifact: "/frame/b.html",
          name: "b.html",
          lastSeen: "",
          id: "idb",
          hosted: false,
          project: "/frame",
        },
      ],
    });
    useShell.setState({ activeKey: "/frame/a.html" });
    recordViewed("/frame/a.html", 5);
    recordViewed("/frame/b.html", 3);

    // B's log grew to 8 and its agent SETTLED (working:false). A grew to 6.
    applyAttentionFrame({
      ida: { openQuestions: 0, working: false, resolved: false, lastEventSeq: 6 },
      idb: { openQuestions: 0, working: false, resolved: true, lastEventSeq: 8 },
    });

    const viewed = useShell.getState().viewedSeq;
    expect(viewed["/frame/a.html"]).toBe(6); // the tab in front tracks - you saw it land
    expect(viewed["/frame/b.html"]).toBe(3); // settling alone does NOT clear unseen
  });
});
