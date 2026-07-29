import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Project-as-scope is deleted (plan 03, M2.1): the tab strip shows every open
 * tab (M2.2 groups them), so the scoped-strip machinery - the drawer, the scope
 * badge, `activeProject`, `visibleTabKeys`, `openProject`, `tabScope` - is gone.
 * This pins two things: a persisted `project` key is tolerated and discarded
 * (so an old localStorage blob does not break a reload), and the deleted
 * symbols cannot quietly return to the source.
 */

const chrome = (p: string): string =>
  readFileSync(join(import.meta.dir, "..", "client", "chrome", p), "utf8");

describe("readStoredTabs tolerates and discards a persisted project key", () => {
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

  test("a `project` key from the scoped era is dropped; the shape round-trips without it", async () => {
    const { readStoredTabs } = await import("../client/chrome/shell.ts");
    localStorage.setItem(
      "lucid.openTabs",
      JSON.stringify({ keys: ["a.html", "b.html"], active: "a.html", project: "/dev/x" }),
    );
    const got = readStoredTabs();
    expect(got).toEqual({ keys: ["a.html", "b.html"], active: "a.html", viewed: {} });
    expect("project" in got).toBe(false);
  });
});

describe("the scoped-strip machinery is deleted from the source (cannot return)", () => {
  // Each pair: the deleted identifier must not appear in that module's source.
  const gone: ReadonlyArray<readonly [string, string]> = [
    ["shell.ts", "activeProject"],
    ["shell.ts", "drawerOpen"],
    ["shell.ts", "setDrawerOpen"],
    ["hub.ts", "visibleTabKeys"],
    ["hub.ts", "openProject"],
    ["hub.ts", "tabScope"],
    ["hub.ts", "latestTabIn"],
    ["naming.ts", "tabScope"],
    ["Shell.tsx", "ProjectsDrawer"],
    ["Shell.tsx", "activeProject"],
    ["Shell.tsx", "visibleTabKeys"],
    ["CreateDialog.tsx", "activeProject"],
  ];

  for (const [file, symbol] of gone) {
    test(`${file} no longer mentions ${symbol}`, () => {
      expect(chrome(file)).not.toContain(symbol);
    });
  }
});
