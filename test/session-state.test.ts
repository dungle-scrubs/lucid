import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../src/core/events.ts";
import { appendEvent, createSessionStateCache, sessionState } from "../src/core/log.ts";
import { sessionPaths } from "../src/core/paths.ts";

/**
 * `sessionState` is the one read seam over a session log: it reads, tolerates a
 * torn tail, folds, and caches the fold on the log file's `mtime + size`.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
  ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

const opened = ev({
  t: "session_opened",
  seq: 1,
  segment: 1,
  version: 1,
  artifact: "plan.html",
  hash: "h",
  path: "versions/s1/v1.html",
} as never);

/** A record whose log holds exactly `content`. */
const withLog = async (content: string) => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-state-"));
  dirs.push(dir);
  const paths = sessionPaths(join(dir, "plan.html"));
  await mkdir(paths.runDir, { recursive: true });
  await writeFile(paths.logPath, content);
  return paths;
};

describe("sessionState: the read", () => {
  test("a missing log is an unopened session, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucid-state-"));
    dirs.push(dir);
    const state = await sessionState(sessionPaths(join(dir, "plan.html")));
    expect(state.status).toBe("none");
  });

  test("a torn TRAILING line (crash mid-append) is tolerated", async () => {
    const paths = await withLog(`${JSON.stringify(opened)}\n{"seq":2,"t":"agent_a`);
    expect((await sessionState(paths)).highSeq).toBe(1); // torn tail dropped; opened stands
  });

  test("a corrupt COMMITTED line is a typed LogError, not silently folded over", async () => {
    const paths = await withLog(`not json\n${JSON.stringify(opened)}\n`);
    await expect(sessionState(paths)).rejects.toThrow(/corrupt committed log line/);
  });

  test("an append is visible to the very next read", async () => {
    const paths = await withLog(`${JSON.stringify(opened)}\n`);
    expect((await sessionState(paths)).questions.length).toBe(0);
    await appendEvent(paths, { t: "question", id: "q1", text: "where?" });
    expect((await sessionState(paths)).questions.length).toBe(1);
  });
});

describe("the fold cache: mtime+size keyed", () => {
  // A stat we control, so we can force the append-in-place edge (size grows,
  // mtime does not) that a size-blind key would miss.
  const controllableCache = () => {
    let events: LogEvent[] = [opened];
    let stat = { mtimeMs: 1000, size: 10 };
    const cache = createSessionStateCache({
      statOf: () => stat,
      read: () => events,
    });
    return {
      cache,
      set: (next: LogEvent[], s: { mtimeMs: number; size: number }) => {
        events = next;
        stat = s;
      },
    };
  };

  test("an unchanged log is a cache hit - no re-fold", () => {
    const { cache } = controllableCache();
    cache.state("/p/log.ndjson");
    cache.state("/p/log.ndjson");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  test("the sync and async reads share one cache", async () => {
    const { cache } = controllableCache();
    cache.state("/p/log.ndjson");
    await cache.stateAsync("/p/log.ndjson");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  test("growth re-folds and never serves stale state", () => {
    const { cache, set } = controllableCache();
    expect(cache.state("/p/log.ndjson").questions.length).toBe(0);
    // a question arrives; the log grows (mtime AND size change)
    set([opened, ev({ t: "question", seq: 2, id: "q1", text: "?" } as never)], {
      mtimeMs: 2000,
      size: 40,
    });
    expect(cache.state("/p/log.ndjson").questions.length).toBe(1); // fresh, not stale
    expect(cache.stats().misses).toBe(2);
  });

  // MUTATION (drop the size half of the key): an append that grows the file but
  // leaves mtime unchanged must still re-fold. A mtime-only key serves stale.
  test("size change alone (mtime frozen) still re-folds", () => {
    const { cache, set } = controllableCache();
    expect(cache.state("/p/log.ndjson").questions.length).toBe(0);
    set([opened, ev({ t: "question", seq: 2, id: "q1", text: "?" } as never)], {
      mtimeMs: 1000, // SAME mtime - only size moved
      size: 40,
    });
    expect(cache.state("/p/log.ndjson").questions.length).toBe(1); // re-folded on size alone
    expect(cache.stats().misses).toBe(2);
  });

  // MUTATION (drop the `forget` call in `appendEventsIf`): a truncate of a torn
  // tail followed by an append of the same byte length inside one mtime tick
  // lands back on the key it started from, so the stat pair alone can never
  // invalidate it. An in-process write says so itself.
  test("forget drops an entry the stat pair can no longer invalidate", () => {
    const { cache, set } = controllableCache();
    expect(cache.state("/p/log.ndjson").questions.length).toBe(0);
    // The write the stat pair cannot see: contents moved, mtime and size did not.
    set([opened, ev({ t: "question", seq: 2, id: "q1", text: "?" } as never)], {
      mtimeMs: 1000,
      size: 10,
    });
    expect(cache.state("/p/log.ndjson").questions.length).toBe(0); // stale, as keyed
    cache.forget("/p/log.ndjson");
    expect(cache.state("/p/log.ndjson").questions.length).toBe(1);
  });

  // MUTATION (drop the bound): a `FoldedState` retains the log's whole text and
  // the hub folds every session under its scan roots, so an unbounded map grows
  // with every log the machine has ever held and never shrinks.
  test("the cache is bounded, evicting the least recently read log", () => {
    const cache = createSessionStateCache({
      statOf: () => ({ mtimeMs: 1000, size: 10 }),
      read: () => [opened],
      maxEntries: 2,
    });
    cache.state("/a/log.ndjson");
    cache.state("/b/log.ndjson");
    cache.state("/a/log.ndjson"); // a read makes `a` the recent one
    cache.state("/c/log.ndjson"); // evicts `b`, not `a`
    expect(cache.stats().entries).toBe(2);
    cache.state("/a/log.ndjson");
    expect(cache.stats().hits).toBe(2); // `a` survived
    cache.state("/b/log.ndjson");
    expect(cache.stats().misses).toBe(4); // `b` did not
  });

  test("a log that disappears drops its entry rather than retaining the fold", () => {
    let present = true;
    const cache = createSessionStateCache({
      statOf: () => {
        if (!present) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { mtimeMs: 1000, size: 10 };
      },
      read: () => (present ? [opened] : []),
    });
    expect(cache.state("/p/log.ndjson").status).toBe("active");
    expect(cache.stats().entries).toBe(1);
    present = false;
    expect(cache.state("/p/log.ndjson").status).toBe("none");
    expect(cache.stats().entries).toBe(0); // the deleted session's fold is gone
  });

  test("a log that cannot be stat'd folds uncached rather than latching", () => {
    let events: LogEvent[] = [];
    const cache = createSessionStateCache({
      statOf: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      read: () => events,
    });
    expect(cache.state("/p/log.ndjson").status).toBe("none");
    events = [opened];
    // Nothing was stored under a key that can never change, so the log
    // appearing is picked up on the next read.
    expect(cache.state("/p/log.ndjson").status).toBe("active");
    expect(cache.stats().entries).toBe(0);
  });
});
