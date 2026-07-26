import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastAttendant, writeAttendantSidecar } from "../src/core/attendant.ts";
import { foldLog } from "../src/core/fold.ts";
import { appendEvent, appendEvents, readEvents } from "../src/core/log.ts";
import { buildWaitPayload } from "../src/core/payload.ts";
import { cursorSidecarPath, sessionPaths, snapshotPath } from "../src/core/paths.ts";
import { commitWatchedChange, openSession } from "../src/core/session.ts";
import { listSessions, projectRoot } from "../src/core/sessions.ts";

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

  test("a multi-target annotation stays resolved while ANY spot survives", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    const gone = {
      kind: "element" as const,
      fingerprint: 'li#zzzz·"gone"',
      domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(9)",
      snippet: "<li>gone</li>",
    };
    const alive = {
      kind: "element" as const,
      fingerprint: 'li#0000·"two"',
      domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(2)",
      snippet: "<li>two</li>",
    };
    await appendEvents(paths.logPath, [
      {
        t: "annotation",
        id: "a-multi",
        version: 1,
        target: gone,
        targets: [gone, alive],
        note: "these two",
      },
      {
        t: "annotation",
        id: "a-all-gone",
        version: 1,
        target: gone,
        targets: [gone, gone],
        note: "nothing left",
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
    const multi = payload.annotations.find((a) => a.id === "a-multi");
    // The first spot no longer attaches, but the second does: the card stays
    // live and the wire carries the full list beside the legacy first.
    expect(multi?.resolved).toBe(true);
    expect(multi?.targets).toHaveLength(2);
    expect(multi?.target).toEqual(gone);
    const allGone = payload.annotations.find((a) => a.id === "a-all-gone");
    expect(allGone?.resolved).toBe(false);
  });
});

describe("per-item delivery state (D20)", () => {
  const payloadOf = async (paths: ReturnType<typeof sessionPaths>) => {
    const state = foldLog((await readEvents(paths.logPath)).events);
    return buildWaitPayload({
      session: paths.artifactPath,
      state,
      status: "feedback",
      currentHtml: await readFile(paths.currentHtml, "utf8"),
      snapshotAbsPath: (rel) => join(paths.sessionDir, rel),
      annotations: state.annotations,
      messages: state.messages,
      nextSeq: state.highSeq,
    });
  };

  test("recorded -> delivered -> answered, per item, from the log alone", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvents(paths.logPath, [
      { t: "prompt", id: "m-1", refs: [], text: "first" },
      {
        t: "annotation",
        id: "a-1",
        version: 1,
        target: {
          kind: "element",
          fingerprint: 'li#0000·"two"',
          domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(2)",
          snippet: "<li>two</li>",
        },
        note: "tighten this",
      },
    ]);

    // Nothing has taken it: both flags absent (never `false` - the wire stays
    // additive).
    const recorded = await payloadOf(paths);
    expect(recorded.messages[0]?.delivered).toBeUndefined();
    expect(recorded.messages[0]?.answered).toBeUndefined();
    expect(recorded.annotations[0]?.delivered).toBeUndefined();

    // An ack delivers the range it CLAIMS - the cursor its taker had read.
    const beforeAck = foldLog((await readEvents(paths.logPath)).events);
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: "ack-1",
      covers: beforeAck.highSeq,
    });
    const delivered = await payloadOf(paths);
    expect(delivered.messages[0]?.delivered).toBe(true);
    expect(delivered.annotations[0]?.delivered).toBe(true);
    expect(delivered.messages[0]?.answered).toBeUndefined();

    // Agent output answers what came BEFORE it, and nothing after.
    await appendEvent(paths.logPath, { t: "agent_reply", id: "r-1", text: "on it" });
    await appendEvent(paths.logPath, { t: "prompt", id: "m-2", refs: [], text: "second" });
    const answered = await payloadOf(paths);
    expect(answered.messages[0]?.answered).toBe(true);
    expect(answered.annotations[0]?.answered).toBe(true);
    const later = answered.messages.find((m) => m.text === "second");
    expect(later?.answered).toBeUndefined();
    expect(later?.delivered).toBeUndefined();
    // The agent's own turn is never delivered or answered to anyone.
    const reply = answered.messages.find((m) => m.role === "agent");
    expect(reply?.delivered).toBeUndefined();
    expect(reply?.answered).toBeUndefined();
  });

  test("the fold's delivery cursors only advance, unlike the working window", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "prompt", id: "m-1", refs: [], text: "hi" });
    const read = foldLog((await readEvents(paths.logPath)).events);
    await appendEvent(paths.logPath, { t: "agent_ack", id: "ack-1", covers: read.highSeq });
    const acked = foldLog((await readEvents(paths.logPath)).events);
    expect(acked.deliveredThroughSeq).toBe(read.highSeq);
    expect(acked.lastAgentOutputSeq).toBe(0);
    expect(acked.agentWorking).not.toBeNull();

    await appendEvent(paths.logPath, { t: "agent_reply", id: "r-1", text: "done" });
    const replied = foldLog((await readEvents(paths.logPath)).events);
    // The output CLOSES the working window but does not clear the delivery
    // cursor: the message stays delivered as well as answered.
    expect(replied.agentWorking).toBeNull();
    expect(replied.deliveredThroughSeq).toBe(acked.deliveredThroughSeq);
    expect(replied.lastAgentOutputSeq).toBeGreaterThan(acked.deliveredThroughSeq);
  });

  test("an ack delivers what it read, not what landed while it was appending", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "prompt", id: "m-1", refs: [], text: "read this" });
    // The cursor the waiter is holding when its payload returns.
    const read = foldLog((await readEvents(paths.logPath)).events);
    // The human keeps typing while the agent's ack is in flight.
    await appendEvent(paths.logPath, { t: "prompt", id: "m-2", refs: [], text: "and this" });
    await appendEvent(paths.logPath, { t: "agent_ack", id: "ack-1", covers: read.highSeq });

    const payload = await payloadOf(paths);
    const first = payload.messages.find((m) => m.text === "read this");
    const second = payload.messages.find((m) => m.text === "and this");
    expect(first?.delivered).toBe(true);
    expect(second?.delivered).toBeUndefined();

    // Output now lands. It answers the batch that was taken - and says nothing
    // about the message nobody has taken yet.
    await appendEvent(paths.logPath, { t: "agent_reply", id: "r-1", text: "done" });
    const after = await payloadOf(paths);
    expect(after.messages.find((m) => m.text === "read this")?.answered).toBe(true);
    expect(after.messages.find((m) => m.text === "and this")?.answered).toBeUndefined();
  });

  test("a presence-only re-ack (intent, progress) delivers nothing", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "prompt", id: "m-1", refs: [], text: "look at this" });
    // What `lucid intent` and `lucid progress` write: presence, no claim.
    await appendEvent(paths.logPath, { t: "agent_ack", id: "ack-1", intent: "revise" });
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: "ack-2",
      progress: { total: 3, done: 1 },
    });
    const state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.deliveredThroughSeq).toBe(0);
    expect(state.agentWorking).not.toBeNull();
    const payload = await payloadOf(paths);
    expect(payload.messages[0]?.delivered).toBeUndefined();
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

describe("the session dir ignores itself", () => {
  test("a fresh session folder carries a .gitignore", async () => {
    const paths = sessionPaths(artifact);
    expect(existsSync(paths.sessionDir)).toBe(false);
    await openSession(paths);
    // The record lands in whatever directory the artifact lives in - often a
    // repo - so it must not show up in `git status` unasked.
    expect(await readFile(join(paths.sessionDir, ".gitignore"), "utf8")).toBe("*\n");
  });

  test("the ignore file goes INSIDE the folder, never beside it", async () => {
    // One level up is the folder holding the ARTIFACTS. A `*` there would
    // quietly ignore the very documents the record exists to protect - which is
    // exactly what the old layout did once artifacts moved into `lucid/`.
    const paths = sessionPaths(artifact);
    await openSession(paths);
    expect(existsSync(join(paths.artifactDir, ".gitignore"))).toBe(false);
  });

  test("a session that predates the behaviour gets one on the next open", async () => {
    // The sessions already polluting someone's repo are precisely the ones that
    // were created before this existed; writing only for a brand-new directory
    // would miss every one of them.
    const paths = sessionPaths(artifact);
    await mkdir(paths.sessionDir, { recursive: true });
    expect(existsSync(join(paths.sessionDir, ".gitignore"))).toBe(false);

    await openSession(paths);
    expect(await readFile(join(paths.sessionDir, ".gitignore"), "utf8")).toBe("*\n");
  });

  test("an edited .gitignore is never overwritten", async () => {
    // Editing it is how a team opts part of the record into git; that decision
    // has to survive every subsequent open.
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await writeFile(join(paths.sessionDir, ".gitignore"), "*\n!log.ndjson\n");

    await openSession(paths);
    expect(await readFile(join(paths.sessionDir, ".gitignore"), "utf8")).toBe("*\n!log.ndjson\n");
  });

  test("an existing session moves out of the old .lucid container, once", async () => {
    // The whole point of the move: `lucid/plan.html` next to `lucid/plan/`,
    // rather than a second hidden `.lucid/` inside the folder artifacts live in.
    const paths = sessionPaths(artifact);
    await mkdir(paths.legacySessionDir, { recursive: true });
    await writeFile(join(paths.legacySessionDir, "log.ndjson"), "", "utf8");
    await writeFile(join(paths.legacySessionDir, "marker"), "kept", "utf8");

    await openSession(paths);
    expect(await readFile(join(paths.sessionDir, "marker"), "utf8")).toBe("kept");
    expect(existsSync(paths.legacySessionDir)).toBe(false);
    // The emptied container goes with it, so nothing hidden is left behind.
    expect(existsSync(join(dir, ".lucid"))).toBe(false);
  });
});

describe("attendant sidecars (D-051 identity)", () => {
  test("records harness identity + resume command; reads back the newest", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);

    await writeAttendantSidecar(paths, {
      harness: "codex",
      nextCursor: "evt_00001",
      at: "2026-07-16T09:00:00.000Z",
      resume: "codex resume abc --yolo",
    });
    await writeAttendantSidecar(paths, {
      harness: "claude-code",
      nextCursor: "evt_00009",
      at: "2026-07-16T10:00:00.000Z",
      resume: "claude --resume xyz --dangerously-skip-permissions",
    });

    // Several harnesses may attend over a session's life; "who to resume"
    // means the most recent one, not whichever file the FS lists first.
    const latest = await readLastAttendant(paths);
    expect(latest?.harness).toBe("claude-code");
    expect(latest?.resume).toBe("claude --resume xyz --dangerously-skip-permissions");

    // The sidecar keeps its documented shape on disk: it is advisory data other
    // tools may read, not an internal encoding.
    const raw = JSON.parse(await readFile(cursorSidecarPath(paths, "codex"), "utf8"));
    expect(raw).toMatchObject({ harness: "codex", nextCursor: "evt_00001" });
  });

  test("no sidecars, an unreadable one, and a session dir that does not exist", async () => {
    const paths = sessionPaths(artifact);
    expect(await readLastAttendant(paths)).toBeUndefined(); // no session dir yet

    await openSession(paths);
    expect(await readLastAttendant(paths)).toBeUndefined(); // opened, never attended

    // Advisory data gone bad must never take down a listing or a state read.
    await writeFile(cursorSidecarPath(paths, "broken"), "{not json");
    expect(await readLastAttendant(paths)).toBeUndefined();

    await writeAttendantSidecar(paths, {
      harness: "gpt",
      nextCursor: "evt_00002",
      at: "2026-07-16T11:00:00.000Z",
    });
    const latest = await readLastAttendant(paths);
    expect(latest?.harness).toBe("gpt");
    expect(latest?.resume).toBeUndefined(); // a harness may decline to record one
  });
});

describe("projectRoot", () => {
  test("returns the nearest ancestor with a .git entry", async () => {
    const root = join(dir, "project");
    const artifactDir = join(root, "nested", "artifacts");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(artifactDir, { recursive: true });

    expect(await projectRoot(sessionPaths(join(artifactDir, "plan.html")))).toBe(root);
  });

  test("falls back to the artifact directory without a .git ancestor", async () => {
    const artifactDir = join(dir, "standalone", "artifacts");
    await mkdir(artifactDir, { recursive: true });

    expect(await projectRoot(sessionPaths(join(artifactDir, "plan.html")))).toBe(artifactDir);
  });
});

describe("listSessions", () => {
  test("lists dormant sessions by name with resume and attendant data", async () => {
    const alphaPaths = sessionPaths(join(dir, "alpha.html"));
    const zetaPaths = sessionPaths(join(dir, "zeta.html"));
    await writeFile(alphaPaths.artifactPath, V1);
    await writeFile(zetaPaths.artifactPath, V1);
    await openSession(zetaPaths);
    await openSession(alphaPaths);
    await writeAttendantSidecar(zetaPaths, {
      harness: "codex",
      nextCursor: "evt_00001",
      at: "2026-07-16T12:00:00.000Z",
      resume: "codex resume zeta",
    });

    const sessions = await listSessions(dir);

    expect(sessions.map((session) => session.name)).toEqual(["alpha.html", "zeta.html"]);
    expect(sessions[0]).toMatchObject({
      session: alphaPaths.artifactPath,
      status: "suspended",
      live: false,
      resume: `lucid open ${alphaPaths.artifactPath}`,
    });
    expect(sessions[1]?.lastAttendant).toEqual({
      harness: "codex",
      at: "2026-07-16T12:00:00.000Z",
      resume: "codex resume zeta",
    });
  });
});
