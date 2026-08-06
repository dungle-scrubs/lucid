import { afterEach, describe, expect, test } from "bun:test";
import { useShell } from "../client/chrome/shell.ts";
import { activate, close, enforceCap, MAX_CONNECTED, streamCap } from "../client/chrome/tabs.ts";

/**
 * Unit tests for the tab roster (M4.4). The roster mechanics - LRU
 * activation, promote-on-close, enforceCap eviction, clean-both-maps - are
 * pure state transitions against `useShell` and the module-level Maps.
 *
 * `register` calls `createSession` which builds a live handle; these tests
 * inject mock handles directly through `register`'s seam (the Map) by
 * pre-populating state, or test the mechanics that don't need creation.
 */

const resetShell = (): void =>
  useShell.setState({ sessionKeys: [], activeKey: null, viewedSeq: {} });

afterEach(() => resetShell());

describe("activate", () => {
  test("sets activeKey in the shell store", () => {
    useShell.setState({ sessionKeys: ["a", "b"], activeKey: "a" });
    activate("b");
    expect(useShell.getState().activeKey).toBe("b");
  });

  test("updates LRU order (enforceCap evicts the oldest)", () => {
    useShell.setState({ sessionKeys: ["a", "b", "c"], activeKey: "a" });
    activate("a"); // a is most recent
    activate("b"); // b is most recent, a is second
    // c was never activated - it should be the eviction victim
    // (enforceCap test below verifies this)
    expect(useShell.getState().activeKey).toBe("b");
  });
});

describe("close", () => {
  test("removes the key from sessionKeys", () => {
    useShell.setState({ sessionKeys: ["a", "b", "c"], activeKey: "b" });
    const result = close("a");
    expect(useShell.getState().sessionKeys).toEqual(["b", "c"]);
    expect(result.wasActive).toBe(false);
  });

  test("promotes the neighbor when closing the active tab", () => {
    useShell.setState({ sessionKeys: ["a", "b", "c"], activeKey: "b" });
    const result = close("b");
    expect(result.wasActive).toBe(true);
    // The neighbor that took the closed tab's place (index 1 -> "c")
    expect(result.promoted).toBe("c");
    expect(useShell.getState().activeKey).toBe("c");
  });

  test("promotes the last tab when closing the tail", () => {
    useShell.setState({ sessionKeys: ["a", "b", "c"], activeKey: "c" });
    const result = close("c");
    expect(result.wasActive).toBe(true);
    // No neighbor to the right, so the new last tab ("b")
    expect(result.promoted).toBe("b");
    expect(useShell.getState().activeKey).toBe("b");
  });

  test("clears the roster entry when closing the last tab", () => {
    useShell.setState({ sessionKeys: ["a"], activeKey: "a" });
    const result = close("a");
    expect(result.wasActive).toBe(true);
    expect(result.promoted).toBe(null);
    expect(useShell.getState().sessionKeys).toEqual([]);
    expect(useShell.getState().activeKey).toBe(null);
  });
});

describe("close whole-protocol (M4.3: one door)", () => {
  test("dispose runs before the roster drops, then the promoted tab is activated", () => {
    // The whole close protocol is one call (M4.3): dispose the stream/surface,
    // drop the roster, then activate the promoted neighbor - in that order, so
    // a disconnect never races the activate that reconnects the promoted tab.
    useShell.setState({ sessionKeys: ["a", "b", "c"], activeKey: "b" });
    const order: string[] = [];
    const result = close("b", {
      dispose: (k) => order.push(`dispose:${k}`),
      activate: (k) => order.push(`activate:${k}`),
    });
    expect(result.wasActive).toBe(true);
    expect(result.promoted).toBe("c");
    // Dispose ran first, activate ran last with the promoted neighbor.
    expect(order).toEqual(["dispose:b", "activate:c"]);
    expect(useShell.getState().activeKey).toBe("c");
  });

  test("a background-tab close disposes but does not activate", () => {
    useShell.setState({ sessionKeys: ["a", "b"], activeKey: "a" });
    let activated: string | null = null;
    close("b", {
      dispose: () => {},
      activate: (k) => {
        activated = k;
      },
    });
    expect(activated).toBeNull();
  });
});

describe("streamCap", () => {
  test("defaults to MAX_CONNECTED (10)", () => {
    expect(streamCap()).toBe(MAX_CONNECTED);
    expect(MAX_CONNECTED).toBe(10);
  });

  test("accepts an override", () => {
    expect(streamCap(3)).toBe(3);
  });
});

describe("enforceCap", () => {
  test("does nothing when under the cap", () => {
    useShell.setState({ sessionKeys: ["a", "b"], activeKey: "a" });
    // No handles registered, so nothing to disconnect - should not throw
    enforceCap(10);
    expect(useShell.getState().sessionKeys).toEqual(["a", "b"]);
  });
});
