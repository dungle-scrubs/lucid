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
    expect(r.committed?.version).toBe(2);
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
