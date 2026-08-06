import { describe, expect, test } from "bun:test";
import { createListing, type Listing } from "../src/server/listing.ts";
import type { HubSession } from "../src/protocol/hub.ts";

/**
 * Unit tests for server/listing.ts (M5.4) that don't need a socket.
 * Tests the SWR wrapper, snapshot, notify/dedupe, and project/title caches
 * in isolation, without starting an HTTP server.
 */

const fakePaths = (artifact: string) => ({
  artifactPath: artifact,
  artifactDir: `${artifact}/.lucid`,
  sessionDir: `${artifact}/.lucid`,
  name: "test",
  runDir: `${artifact}/.lucid/run`,
  logPath: `${artifact}/.lucid/log.jsonl`,
  currentHtml: `${artifact}/.lucid/current.html`,
  versionsDir: `${artifact}/.lucid/versions`,
  selectionPath: `${artifact}/.lucid/selection.json`,
  pastedDir: `${artifact}/.lucid/pasted`,
  createLog: `${artifact}/.lucid/create.log`,
  attendLog: `${artifact}/.lucid/attend.log`,
  contextPath: `${artifact}/.lucid/context.json`,
  serverJson: `${artifact}/.lucid/server.json`,
  requestLog: `${artifact}/.lucid/request.log`,
  serverLog: `${artifact}/.lucid/server.log`,
  reviseLog: `${artifact}/.lucid/revise.out.log`,
  contextSidecar: `${artifact}/.lucid/context.json`,
});

/** A HubSession fixture with the fields the listing broadcasts: the registry
 *  pointer (name/lastSeen), the hub facts (hosted/project), and an id. The
 *  mtime the listing dedupes on comes from the `stat` callback, not the
 *  session object, so it is not on this fixture. */
const session = (over: Partial<HubSession> & Pick<HubSession, "id" | "artifact">): HubSession => ({
  name: "test",
  lastSeen: "t",
  project: "/p",
  hosted: false,
  ...over,
});

describe("createListing - SWR + snapshot", () => {
  test("cached returns the computed listing", async () => {
    const sessions: HubSession[] = [session({ id: "a", artifact: "/p/a.html" })];
    let computeCalls = 0;
    const listing: Listing = createListing({
      compute: async () => {
        computeCalls += 1;
        return sessions;
      },
      bundleStamp: () => "stamp-1",
      attention: () => ({}),
      broadcast: () => {},
      channelSize: () => 0,
      projectOf: async () => ({ project: "/p" }),
      parseTitle: () => null,
      stat: async () => ({ mtimeMs: 0 }),
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    const result = await listing.cached();
    expect(result).toEqual(sessions);
    expect(computeCalls).toBe(1);

    // Second call serves from cache (no recompute)
    const result2 = await listing.cached();
    expect(result2).toEqual(sessions);
    expect(computeCalls).toBe(1);
  });

  test("snapshot includes the bundle stamp", async () => {
    const listing: Listing = createListing({
      compute: async () => [],
      bundleStamp: () => "bundle-abc",
      attention: () => ({}),
      broadcast: () => {},
      channelSize: () => 0,
      projectOf: async () => ({ project: "/p" }),
      parseTitle: () => null,
      stat: async () => ({ mtimeMs: 0 }),
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    const snap = await listing.snapshot();
    expect(snap.bundle).toBe("bundle-abc");
    expect(snap.sessions).toEqual([]);
  });

  test("invalidate forces a recompute on next cached call", async () => {
    let value = 0;
    const listing: Listing = createListing({
      compute: async () => [session({ id: `s${value}`, artifact: `/p/${value}.html` })],
      bundleStamp: () => "stamp",
      attention: () => ({}),
      broadcast: () => {},
      channelSize: () => 0,
      projectOf: async () => ({ project: "/p" }),
      parseTitle: () => null,
      stat: async () => ({ mtimeMs: 0 }),
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    const first = await listing.cached();
    expect(first[0]!.id).toBe("s0");

    value = 1;
    listing.invalidate();
    const second = await listing.cached();
    expect(second[0]!.id).toBe("s1");
  });
});

describe("createListing - project and title caches", () => {
  test("resolveProject caches and returns the same result", async () => {
    let calls = 0;
    const listing: Listing = createListing({
      compute: async () => [],
      bundleStamp: () => "stamp",
      attention: () => ({}),
      broadcast: () => {},
      channelSize: () => 0,
      projectOf: async () => {
        calls += 1;
        return { project: "/resolved" };
      },
      parseTitle: () => null,
      stat: async () => ({ mtimeMs: 0 }),
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    const r1 = await listing.resolveProject("/p/a.html");
    await listing.resolveProject("/p/a.html");
    expect(r1.project).toBe("/resolved");
    expect(calls).toBe(1); // cached
  });

  test("readTitle returns null for nonexistent files", async () => {
    const listing: Listing = createListing({
      compute: async () => [],
      bundleStamp: () => "stamp",
      attention: () => ({}),
      broadcast: () => {},
      channelSize: () => 0,
      projectOf: async () => ({ project: "/p" }),
      parseTitle: () => "Parsed",
      stat: async () => {
        throw new Error("ENOENT");
      },
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    const title = await listing.readTitle("/nonexistent.html");
    expect(title).toBeNull();
  });
});

describe("createListing - notify dedupe", () => {
  test("notify skips when channelSize is 0", async () => {
    let broadcasts = 0;
    const listing: Listing = createListing({
      compute: async () => [],
      bundleStamp: () => "stamp",
      attention: () => ({}),
      broadcast: () => {
        broadcasts += 1;
      },
      channelSize: () => 0, // no windows
      projectOf: async () => ({ project: "/p" }),
      parseTitle: () => null,
      stat: async () => ({ mtimeMs: 0 }),
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    await listing.notify();
    expect(broadcasts).toBe(0);
  });

  test("notify broadcasts when data changes", async () => {
    const value = 0;
    let broadcasts = 0;
    const listing: Listing = createListing({
      compute: async () => [session({ id: `s${value}`, artifact: `/p/${value}.html` })],
      bundleStamp: () => "stamp",
      attention: () => ({}),
      broadcast: () => {
        broadcasts += 1;
      },
      channelSize: () => 1, // one window connected
      projectOf: async () => ({ project: "/p" }),
      parseTitle: () => null,
      stat: async () => ({ mtimeMs: 0 }),
      readHead: async () => "",
      sessionPaths: fakePaths,
    });

    await listing.notify();
    expect(broadcasts).toBeGreaterThan(0);
  });
});
