import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldLog } from "../src/core/fold.ts";
import { appendEvent, appendEvents, readEvents } from "../src/core/log.ts";
import { buildWaitPayload } from "../src/core/payload.ts";
import { sessionPaths, snapshotPath } from "../src/core/paths.ts";
import { commitWatchedChange, openSession } from "../src/core/session.ts";

let dir: string;
let artifact: string;

const V1 = "<html><body><article><ol><li>one</li><li>two</li></ol></article></body></html>";
const V2 =
  "<html><body><article><ol><li>ONE</li><li>two</li><li>three</li></ol></article></body></html>";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-test-"));
  artifact = join(dir, "plan.html");
  await writeFile(artifact, V1);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("log append", () => {
  test("assigns monotonic seq and dedupes by id", async () => {
    const paths = sessionPaths(artifact);
    await Bun.write(paths.logPath, "");
    const a = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "id-1",
      version: 1,
      target: { kind: "element", fingerprint: "f", domPath: "p", snippet: "s" },
      note: "first",
    });
    expect(a.seq).toBe(1);
    // duplicate id -> returns existing, no new seq
    const dup = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "id-1",
      version: 1,
      target: { kind: "element", fingerprint: "f", domPath: "p", snippet: "s" },
      note: "first again",
    });
    expect(dup.seq).toBe(1);
    const b = await appendEvent(paths.logPath, {
      t: "prompt",
      id: "id-2",
      refs: [],
      text: "hi",
    });
    expect(b.seq).toBe(2);
    const { events } = await readEvents(paths.logPath);
    expect(events.length).toBe(2);
  });

  test("tolerates a torn trailing line", async () => {
    const paths = sessionPaths(artifact);
    const good = JSON.stringify({
      t: "session_opened",
      seq: 1,
      at: "x",
      segment: 1,
      artifact: "a",
      version: 1,
      hash: "h",
      path: "p",
    });
    await Bun.write(paths.logPath, `${good}\n{"t":"version","seq":2`); // torn
    const { events, tornTail } = await readEvents(paths.logPath);
    expect(tornTail).toBe(true);
    expect(events.length).toBe(1);
  });

  test("concurrent appends do not collide on seq", async () => {
    const paths = sessionPaths(artifact);
    await Bun.write(paths.logPath, "");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendEvent(paths.logPath, { t: "agent_reply", id: `r${i}`, text: `m${i}` }),
      ),
    );
    const { events } = await readEvents(paths.logPath);
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("openSession lifecycle", () => {
  test("fresh open writes session_opened + snapshot + current.html", async () => {
    const paths = sessionPaths(artifact);
    const r = await openSession(paths);
    expect(r.startedSegment).toBe(true);
    expect(r.state.status).toBe("active");
    expect(r.state.version).toBe(1);
    expect(existsSync(paths.currentHtml)).toBe(true);
    expect(existsSync(snapshotPath(paths, 1, 1))).toBe(true);
    expect(await readFile(paths.currentHtml, "utf8")).toBe(V1);
  });

  test("end then reopen starts segment 2 with non-colliding snapshot (D-045/D-050)", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "session_ended" });
    const r2 = await openSession(paths);
    expect(r2.startedSegment).toBe(true);
    expect(r2.state.segment).toBe(2);
    expect(existsSync(snapshotPath(paths, 2, 1))).toBe(true);
    expect(existsSync(snapshotPath(paths, 1, 1))).toBe(true);
    // seq continues monotonically across the boundary
    const { events } = await readEvents(paths.logPath);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r2.cursor).toBeGreaterThan(1);
  });

  test("resume on suspended reconciles a file changed while suspended (D-061)", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "session_suspended" });
    // user edits the file while suspended (watcher stopped)
    await writeFile(artifact, V2);
    const r = await openSession(paths);
    expect(r.state.status).toBe("active");
    expect(r.state.version).toBe(2); // reconciled
    expect(await readFile(paths.currentHtml, "utf8")).toBe(V2);
  });
});

describe("commitWatchedChange", () => {
  test("commits a structurally valid change", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await writeFile(artifact, V2);
    const r = await commitWatchedChange(paths);
    expect(r.committed?.t).toBe("version");
    expect(r.committed && "version" in r.committed ? r.committed.version : undefined).toBe(2);
    expect(r.warning).toBeUndefined();
  });

  test("rejects a truncated change with a warning, no version", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await writeFile(artifact, "<html><body><li>Backfill from the even");
    const r = await commitWatchedChange(paths);
    expect(r.committed).toBeUndefined();
    expect(r.warning?.code).toBe("STRUCTURE_INVALID");
    const state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.version).toBe(1); // unchanged
  });
});

describe("buildWaitPayload resolution", () => {
  test("resolved=true for an anchor that still attaches; orphan for one that does not", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    // annotation on v1 targeting <li>two</li>
    await appendEvents(paths.logPath, [
      {
        t: "annotation",
        id: "a-keep",
        version: 1,
        target: {
          kind: "element",
          fingerprint: 'li#0000·"two"',
          domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(2)",
          snippet: "<li>two</li>",
          lucidId: undefined as unknown as string,
        },
        note: "keep",
      },
      {
        t: "annotation",
        id: "a-orphan",
        version: 1,
        target: {
          kind: "element",
          fingerprint: 'li#zzzz·"gone"',
          domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(9)",
          snippet: "<li>gone</li>",
        },
        note: "orphan",
      },
    ]);
    const state = foldLog((await readEvents(paths.logPath)).events);
    const payload = await buildWaitPayload({
      session: paths.artifactPath,
      state,
      status: "feedback",
      currentHtml: await readFile(paths.currentHtml, "utf8"),
      snapshotAbsPath: (rel) => join(paths.sessionDir, rel),
      annotations: state.annotations,
      messages: state.messages,
      nextSeq: state.highSeq,
    });
    const keep = payload.annotations.find((a) => a.id === "a-keep");
    const orphan = payload.annotations.find((a) => a.id === "a-orphan");
    expect(keep?.resolved).toBe(true);
    expect(orphan?.resolved).toBe(false);
  });

  test("orphans (never re-anchors) when the authored-version snapshot is missing (D-035)", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    // Annotate v1 against <li>two</li>, then revise to v2.
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-v1",
      version: 1,
      target: {
        kind: "element",
        fingerprint: 'li#0000·"two"',
        domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(2)",
        snippet: "<li>two</li>",
      },
      note: "still on v1",
    });
    await writeFile(artifact, V2);
    await commitWatchedChange(paths);
    // Destroy the v1 snapshot so the authored version can't be verified.
    await rm(snapshotPath(paths, 1, 1), { force: true });

    const state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.version).toBe(2);
    const payload = await buildWaitPayload({
      session: paths.artifactPath,
      state,
      status: "feedback",
      currentHtml: await readFile(paths.currentHtml, "utf8"),
      snapshotAbsPath: (rel) => join(paths.sessionDir, rel),
      annotations: state.annotations,
      messages: state.messages,
      nextSeq: state.highSeq,
    });
    const a = payload.annotations.find((x) => x.id === "a-v1");
    expect(a?.resolved).toBe(false); // orphaned, not re-pointed at v2
    expect(payload.warnings?.some((w) => w.code === "SNAPSHOT_MISSING")).toBe(true);
  });
});

describe("cursor delivery (at-least-once, no gaps, no duplicates)", () => {
  test("append recovers after a torn trailing line (crash mid-append then restart)", async () => {
    const paths = sessionPaths(artifact);
    // A clean committed line, then a torn (crash-mid-append) line.
    const good = JSON.stringify({
      t: "session_opened",
      seq: 1,
      at: "x",
      segment: 1,
      artifact: "a",
      version: 1,
      hash: "h",
      path: "p",
    });
    await Bun.write(paths.logPath, `${good}\n{"t":"version","seq":2`);
    // The next append must re-read, drop the torn tail, and continue monotonic.
    const ev = await appendEvent(paths.logPath, {
      t: "agent_reply",
      id: "r1",
      text: "after crash",
    });
    expect(ev.seq).toBe(2);
    const { events } = await readEvents(paths.logPath);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1]?.t).toBe("agent_reply");
  });

  test("staggered readers each see exactly the events in (cursor, nextCursor]", async () => {
    // Drives the same invariant runWait uses: slice by seq against a log under
    // concurrent append pressure. If seq assignment or slicing were racy, a
    // reader would see a gap or a duplicate.
    const paths = sessionPaths(artifact);
    await Bun.write(paths.logPath, "");
    const total = 40;
    // Appenders: 40 identified events under the lock in parallel.
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        appendEvent(paths.logPath, { t: "agent_reply", id: `r${i}`, text: `m${i}` }),
      ),
    );
    const { events } = await readEvents(paths.logPath);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));

    // Simulate N readers with staggered cursors; each must receive exactly the
    // contiguous run after its cursor, with no gaps and no duplicates.
    const sliceDelta = <T extends { readonly seq: number }>(items: readonly T[], cursor: number) =>
      items.filter((i) => i.seq > cursor);
    for (let cursor = 0; cursor <= total; cursor++) {
      const delta = sliceDelta(events, cursor);
      const deltaSeqs = delta.map((e) => e.seq);
      // contiguous from cursor+1..total, no dupes, no gaps.
      expect(deltaSeqs).toEqual(Array.from({ length: total - cursor }, (_, i) => cursor + 1 + i));
      // ids are unique within the delta (idempotent delivery contract).
      expect(new Set(delta.map((e) => (e as { id: string }).id)).size).toBe(delta.length);
    }
  });

  test("cursor survives end-then-reopen across segments with no gap (D-045/D-050)", async () => {
    // A persisted cursor must stay valid across an end -> reopen: seq is globally
    // monotonic and never reset, so a reader holding the pre-end cursor sees the
    // new segment's events as a continuation, not a repeat of segment 1.
    const paths = sessionPaths(artifact);
    // Segment 1: session_opened (seq 1), an annotation (seq 2), ended (seq 3).
    await openSession(paths);
    const a1 = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "seg1-1",
      version: 1,
      target: { kind: "element", fingerprint: "f", domPath: "li:nth-child(1)", snippet: "s" },
      note: "first",
    });
    expect(a1.seq).toBe(2);
    await appendEvent(paths.logPath, { t: "session_ended" });
    const beforeReopen = await readEvents(paths.logPath);
    expect(beforeReopen.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const persistedCursor = 2; // the agent advanced past seq 2

    // Reopen starts segment 2 in the same log; seqs continue (not reset).
    await openSession(paths);
    const afterReopen = await readEvents(paths.logPath);
    const seg2Opened = afterReopen.events.find((e) => e.t === "session_opened" && e.seq > 3);
    expect(seg2Opened).toBeTruthy();
    expect(seg2Opened?.seq).toBe(4); // continues the global monotonic seq

    // A reader with the pre-end cursor sees exactly (cursor, highSeq] with no
    // gap and no segment-1 duplicate: the ended event + the new session_opened.
    const slice = afterReopen.events.filter((e) => e.seq > persistedCursor);
    expect(slice.map((e) => e.seq)).toEqual([3, 4]);
    expect(slice.some((e) => e.t === "annotation" && e.id === "seg1-1")).toBe(false);
  });

  test("writer swap mid-segment does not duplicate or drop (server then direct CLI write)", async () => {
    // The contract: an identified event appended by one writer, then re-appended
    // (same id) by a different writer after a simulated crash, dedupes; a
    // distinct event appended after lands at the next seq. This is the
    // open->wait->(crash)->resume path where the server is the first writer and
    // the CLI writes directly under the lock when no server is live.
    const paths = sessionPaths(artifact);
    await openSession(paths);
    const first = await appendEvent(paths.logPath, {
      t: "prompt",
      id: "msg-1",
      refs: [],
      text: "from server writer",
    });
    expect(first.seq).toBe(2);

    // Simulate the CLI re-issuing the same idempotent id after a restart
    // (at-least-once delivery => the same message may be POSTed twice).
    const deduped = await appendEvent(paths.logPath, {
      t: "prompt",
      id: "msg-1",
      refs: [],
      text: "from server writer",
    });
    expect(deduped.seq).toBe(2); // returns the existing event, no new seq

    // A new, distinct event continues the monotonic seq.
    const next = await appendEvent(paths.logPath, {
      t: "prompt",
      id: "msg-2",
      refs: [],
      text: "from cli writer",
    });
    expect(next.seq).toBe(3);

    const { events } = await readEvents(paths.logPath);
    const prompts = events.filter((e) => e.t === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((e) => e.seq)).toEqual([2, 3]);
  });
});
