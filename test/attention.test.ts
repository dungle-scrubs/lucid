import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionOf, createAttentionCache } from "../src/core/attention.ts";
import type { LogEvent } from "../src/core/events.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * The attention fold (plan 03, M1.1). `attentionOf` reduces a log to the four
 * signals the grouped tab strip needs - open questions, the working window,
 * approval, and the high-water seq - and the cache keeps an idle artifact at
 * one stat per poll instead of a full fold.
 */

const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
  ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

const opened = ev({ t: "session_opened", seq: 1, artifact: "plan.html" } as never);

describe("attentionOf: the four signals", () => {
  test("openQuestions counts unanswered questions, not answered or skipped ones", () => {
    const a = attentionOf([
      opened,
      ev({ t: "question", seq: 2, id: "q1", text: "where?" } as never),
      ev({ t: "question", seq: 3, id: "q2", text: "when?" } as never),
      ev({ t: "question_answered", seq: 4, questionId: "q2", answer: "now" } as never),
    ]);
    expect(a.openQuestions).toBe(1); // q1 open, q2 answered
  });

  test("working is true while the agent-work window is open, false once output lands", () => {
    const acked = attentionOf([
      opened,
      ev({ t: "annotation", seq: 2, id: "n1", target: {}, note: "fix" } as never),
      ev({ t: "agent_ack", seq: 3 } as never),
    ]);
    expect(acked.working).toBe(true);
    const produced = attentionOf([
      opened,
      ev({ t: "agent_ack", seq: 3 } as never),
      ev({ t: "version", seq: 4, version: 2, hash: "h", path: "versions/s1/v2.html" } as never),
    ]);
    expect(produced.working).toBe(false); // the version closed the window
  });

  test("resolved reflects the review approval toggle", () => {
    expect(attentionOf([opened]).resolved).toBe(false);
    const approved = attentionOf([opened, ev({ t: "review_resolved", seq: 2 } as never)]);
    expect(approved.resolved).toBe(true);
  });

  test("lastEventSeq is the monotonic high-water mark", () => {
    expect(attentionOf([opened]).lastEventSeq).toBe(1);
    expect(attentionOf([opened, ev({ t: "agent_ack", seq: 7 } as never)]).lastEventSeq).toBe(7);
  });
});

describe("the cache's default reader matches readEvents (invariant: never disagree)", () => {
  const withLog = async (content: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "lucid-att-"));
    dirs.push(dir);
    const p = join(dir, "log.ndjson");
    await writeFile(p, content);
    return p;
  };

  test("a torn TRAILING line (crash mid-append) is tolerated", async () => {
    const cache = createAttentionCache();
    const p = await withLog(`${JSON.stringify(opened)}\n{"seq":2,"t":"agent_a`);
    expect(cache.get(p).lastEventSeq).toBe(1); // torn tail dropped; opened stands
  });

  test("a corrupt COMMITTED line is fatal, not silently folded over", async () => {
    const cache = createAttentionCache();
    const p = await withLog(`not json\n${JSON.stringify(opened)}\n`);
    expect(() => cache.get(p)).toThrow(/corrupt committed log line/);
  });
});

describe("createAttentionCache: mtime+size keyed", () => {
  // A stat we control, so we can force the append-in-place edge (size grows,
  // mtime does not) that a size-blind key would miss.
  const controllableCache = () => {
    let events: LogEvent[] = [opened];
    let stat = { mtimeMs: 1000, size: 10 };
    const cache = createAttentionCache({
      statOf: () => stat,
      readEvents: () => events,
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
    cache.get("/p/log.ndjson");
    cache.get("/p/log.ndjson");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  test("growth re-folds and never serves stale attention", () => {
    const { cache, set } = controllableCache();
    expect(cache.get("/p/log.ndjson").openQuestions).toBe(0);
    // a question arrives; the log grows (mtime AND size change)
    set([opened, ev({ t: "question", seq: 2, id: "q1", text: "?" } as never)], {
      mtimeMs: 2000,
      size: 40,
    });
    expect(cache.get("/p/log.ndjson").openQuestions).toBe(1); // fresh, not stale
    expect(cache.stats().misses).toBe(2);
  });

  // MUTATION (drop the size half of the key): an append that grows the file but
  // leaves mtime unchanged must still re-fold. A mtime-only key serves stale.
  test("size change alone (mtime frozen) still re-folds", () => {
    const { cache, set } = controllableCache();
    expect(cache.get("/p/log.ndjson").openQuestions).toBe(0);
    set([opened, ev({ t: "question", seq: 2, id: "q1", text: "?" } as never)], {
      mtimeMs: 1000, // SAME mtime - only size moved
      size: 40,
    });
    expect(cache.get("/p/log.ndjson").openQuestions).toBe(1); // re-folded on size alone
    expect(cache.stats().misses).toBe(2);
  });
});
