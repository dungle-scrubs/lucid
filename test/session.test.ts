import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mutateAttendantSidecar,
  readLastAttendant,
  recordPendingIdentity,
  recordSessionInvalidation,
  mergeAttendantSidecar,
} from "../src/core/attendant.ts";
import { parseHTML } from "linkedom";
import { captureElementAnchor } from "../src/anchors/dom.ts";
import type { DomElementLike, DomRootLike } from "../src/anchors/dom.ts";
import type { Anchor } from "../src/anchors/anchor.ts";
import { foldLog } from "../src/core/fold.ts";
import { appendEvent, appendEvents, readEvents } from "../src/core/log.ts";
import { assemblePayload, buildWaitPayload } from "../src/core/payload.ts";
import { cursorSidecarPath, sessionPaths, snapshotPath } from "../src/core/paths.ts";
import { commitWatchedChange, ensureSessionDirs, openSession } from "../src/core/session.ts";
import { promotePendingBindings } from "../src/core/deliver.ts";
import { listSessions, projectRoot } from "../src/core/sessions.ts";

let dir: string;
let artifact: string;

const V1 = "<html><body><article><ol><li>one</li><li>two</li></ol></article></body></html>";
const V2 =
  "<html><body><article><ol><li>ONE</li><li>two</li><li>three</li></ol></article></body></html>";

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-test-")));
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

describe("working window over a recorded log", () => {
  /**
   * The replay migration (plan 08, D-020). Making `session_ended` close the
   * working window CHANGES how existing logs fold: one that ended with a
   * dangling ack folded OPEN before and folds CLOSED now. That is intended,
   * and it is pinned here against a log the SYSTEM wrote - openSession and
   * appendEvents through the real append path, seqs and timestamps assigned by
   * the code under test - rather than against hand-authored event objects,
   * which could agree with a fold that had drifted from what the writer
   * actually emits.
   *
   * Recorded fresh each run rather than checked in: a fixture file would rot
   * silently, and the only real logs available carry someone's review content,
   * which has no business in this repository (D-005).
   */
  test("a real ended log folds with no open window; a real live one keeps it", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);

    // A turn takes the batch and produces nothing - the shape that left the
    // viewer saying "agent picked up your feedback Nm ago - no response yet"
    // for the life of the session (plan 08 finding #1).
    await appendEvents(paths.logPath, [
      {
        t: "annotation",
        id: "a-1",
        version: 1,
        target: { kind: "element", fingerprint: "f", domPath: "li", snippet: "<li>one</li>" },
        note: "needs a rethink",
      },
      { t: "agent_ack", id: "ack-1", covers: 2 },
    ]);

    // Live: nothing has closed it, and nothing should.
    const live = foldLog((await readEvents(paths.logPath)).events);
    expect(live.agentWorking).not.toBeNull();

    // Ended: the session is over, so no turn is running.
    await appendEvent(paths.logPath, { t: "session_ended" });
    const ended = foldLog((await readEvents(paths.logPath)).events);
    expect(ended.agentWorking).toBeNull();

    // The close must not have been bought by advancing output accounting -
    // ending a session produced nothing, so the annotation is still unanswered.
    expect(ended.lastAgentOutputSeq).toBe(0);
  });

  /**
   * Closing a window is not the same act as producing output, and the fold
   * must not conflate them (plan 08 M2, D-018). They shared a branch: the
   * closers also set `lastAgentOutputSeq`, which `payload.ts` reads to mark an
   * item ANSWERED. Any new closer added to that branch would therefore claim a
   * turn had answered feedback it never touched - the strongest possible chip
   * on no evidence at all.
   */
  test("closing a window without output leaves delivery accounting alone", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvents(paths.logPath, [
      {
        t: "annotation",
        id: "a-1",
        version: 1,
        target: { kind: "element", fingerprint: "f", domPath: "li", snippet: "<li>one</li>" },
        note: "needs a rethink",
      },
      { t: "agent_ack", id: "ack-1", covers: 2 },
    ]);
    await appendEvent(paths.logPath, { t: "session_ended" });

    const state = foldLog((await readEvents(paths.logPath)).events);
    const payload = await assemblePayload(paths, state, "ended", {
      annotations: state.annotations,
      messages: state.messages,
    });
    const item = payload.annotations[0];

    // Delivered, because an agent claimed the batch that held it...
    expect(item?.delivered).toBe(true);
    // ...but NOT answered: the turn ended without producing anything.
    expect(item?.answered).toBeUndefined();

    // Both cursors say so directly.
    expect(state.deliveredThroughSeq).toBe(2);
    expect(state.lastAgentOutputSeq).toBe(0);
  });

  test("real output DOES answer, so the assertion above can fail", async () => {
    // The discriminator for the test above: same log, one real output added.
    // Without this, "answered is undefined" would pass against a fold that
    // never marks anything answered at all.
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvents(paths.logPath, [
      {
        t: "annotation",
        id: "a-1",
        version: 1,
        target: { kind: "element", fingerprint: "f", domPath: "li", snippet: "<li>one</li>" },
        note: "needs a rethink",
      },
      { t: "agent_ack", id: "ack-1", covers: 2 },
      { t: "agent_reply", id: "r-1", text: "rethought it" },
    ]);

    const state = foldLog((await readEvents(paths.logPath)).events);
    const payload = await assemblePayload(paths, state, "feedback", {
      annotations: state.annotations,
      messages: state.messages,
    });
    expect(payload.annotations[0]?.answered).toBe(true);
    expect(state.lastAgentOutputSeq).toBeGreaterThan(0);
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

  test("a freshly pulled record (no run/) opens without minting a version (MB.3)", async () => {
    // run/ is machine-local and gitignored, so a record pulled on another
    // machine arrives with NO current.html - only its committed log and
    // snapshots. The reconcile must compare the artifact against the newest
    // committed SNAPSHOT, not the absent current.html: treating that absence as
    // a change mints a spurious version on every open, forever (D-012).
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "session_suspended" });
    // Simulate the pull: the whole run/ dir (current.html, lock, ...) is gone,
    // but the artifact and the committed versions/ snapshots remain unchanged.
    await rm(paths.runDir, { recursive: true, force: true });

    const r = await openSession(paths);
    expect(r.state.status).toBe("active");
    expect(r.state.version).toBe(1); // NOT 2 - the artifact matches the snapshot
    // ...and the serve cache is rebuilt so the session can actually be served.
    expect(await readFile(paths.currentHtml, "utf8")).toBe(V1);
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

  test("refuses a change on a suspended session WITHOUT clobbering the baseline", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, { t: "session_suspended" });
    await writeFile(artifact, V2);
    const r = await commitWatchedChange(paths);
    expect(r.committed).toBeUndefined();
    expect(r.warning?.code).toBe("SESSION_NOT_ACTIVE");
    // The refusal must leave the change COMMITTABLE: current.html still holds
    // the pre-change baseline (clobbering it here is what silently lost the
    // version forever), and no orphan snapshot was written.
    expect(await readFile(paths.currentHtml, "utf8")).toBe(V1);
    expect(existsSync(snapshotPath(paths, 1, 2))).toBe(false);
    // Once the session resumes, the same change commits as v2.
    await appendEvent(paths.logPath, { t: "session_resumed", segment: 1 });
    const again = await commitWatchedChange(paths);
    expect(again.committed && "version" in again.committed ? again.committed.version : 0).toBe(2);
  });
});

/** A genuinely exact anchor for `<li>two</li>` in V1: captured, not spelled. */
const exactAnchorForTwo = (): Anchor => {
  const { document } = parseHTML(V1);
  const root = document as unknown as DomRootLike;
  return captureElementAnchor(root.querySelectorAll("li")[1] as DomElementLike);
};

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

  /**
   * The floor of #47 (plan 05, M2.2): a resolution that survived only because
   * something still occupies that slot is reported as a guess. Before this the
   * payload said `resolved: true` and nothing else, so an agent acting on the
   * note edited whatever had drifted into position.
   */
  test("a positional-only resolution is resolved AND carries confidence: low", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-guess",
      version: 1,
      target: {
        // No lucidId, and a fingerprint that matches nothing in V1: only the
        // domPath can land, and it lands on whatever sits in slot 2.
        kind: "element",
        fingerprint: 'li#zzzz·"a row that is not here"',
        domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(2)",
        snippet: "<li>drifted</li>",
      },
      note: "positional",
    });
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
    const guess = payload.annotations.find((a) => a.id === "a-guess");
    expect(guess?.resolved).toBe(true);
    expect(guess?.confidence).toBe("low");
  });

  test("an EXACT resolution carries no confidence field at all (an older reader is unaffected)", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-exact",
      version: 1,
      // A REAL captured anchor. The hand-written `li#0000·"two"` used
      // elsewhere in this file matches no element, so it resolves through the
      // domPath - positional, which is the case below, not this one.
      target: exactAnchorForTwo(),
      note: "exact",
    });
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
    const exact = payload.annotations.find((a) => a.id === "a-exact");
    expect(exact?.resolved).toBe(true);
    expect("confidence" in (exact ?? {})).toBe(false);
  });

  test("a MISS is resolved: false and never a low-confidence maybe", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-miss",
      version: 1,
      target: {
        kind: "element",
        fingerprint: 'li#zzzz·"gone"',
        domPath: "article:nth-child(1)>ol:nth-child(1)>li:nth-child(9)",
        snippet: "<li>gone</li>",
      },
      note: "miss",
    });
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
    const miss = payload.annotations.find((a) => a.id === "a-miss");
    expect(miss?.resolved).toBe(false);
    expect(miss?.confidence).toBeUndefined();
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
    expect(await readFile(join(paths.sessionDir, ".gitignore"), "utf8")).toBe("run/\n");
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
    expect(await readFile(join(paths.sessionDir, ".gitignore"), "utf8")).toBe("run/\n");
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

  // The legacy `.lucid/` container migration was DELETED in plan 02 MB.2: the
  // canonical layout puts the record under `.lucid/` deliberately, and the
  // one-time move to canonical is the migration TOOL's job (MB.4/MB.5), not an
  // open-time rename. The test that exercised the old open-time move is gone
  // with the behavior.
});

describe("attendant sidecars (D-051 identity)", () => {
  test("records harness identity + resume command; reads back the newest", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);

    await mergeAttendantSidecar(paths, {
      harness: "codex",
      nextCursor: "evt_00001",
      at: "2026-07-16T09:00:00.000Z",
      resume: "codex resume abc --yolo",
    });
    await mergeAttendantSidecar(paths, {
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

    await mergeAttendantSidecar(paths, {
      harness: "gpt",
      nextCursor: "evt_00002",
      at: "2026-07-16T11:00:00.000Z",
    });
    const latest = await readLastAttendant(paths);
    expect(latest?.harness).toBe("gpt");
    expect(latest?.resume).toBeUndefined(); // a harness may decline to record one
  });
});

describe("attendant sidecar mutation (harness session identity)", () => {
  test("a writer that names fewer fields no longer erases the other writer's", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    // The agent's wait turn records the full identity story...
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      nextCursor: "evt_00004",
      at: "2026-07-16T09:00:00.000Z",
      resume: "codex exec resume abc",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    // ...and the launcher's narrower stamp must UPDATE, not clobber.
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      nextCursor: "evt_00009",
      at: "2026-07-16T10:00:00.000Z",
    });
    const merged = await readLastAttendant(paths);
    expect(merged).toMatchObject({
      harness: "codex",
      nextCursor: "evt_00009",
      at: "2026-07-16T10:00:00.000Z",
      resume: "codex exec resume abc",
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  test("identity, cursor, and invalidations survive concurrent updates", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await mutateAttendantSidecar(paths, "codex", (current) => ({
      ...(current ?? { harness: "codex", at: "2026-07-16T09:00:00.000Z" }),
      sessionId: "0199-native",
      sessionIdAuthority: "observed",
      launchId: "abc123def4567890",
    }));
    // Discovery, `lucid wait`, and invalidation all write at once.
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        recordSessionInvalidation(paths, "codex", `dead-${i}`),
      ),
      mutateAttendantSidecar(paths, "codex", (current) => ({
        ...(current ?? { harness: "codex", at: "x" }),
        nextCursor: "evt_00042",
        at: "2026-07-16T11:00:00.000Z",
      })),
      mutateAttendantSidecar(paths, "codex", (current) => ({
        ...(current ?? { harness: "codex", at: "x" }),
        model: "gpt-5.6-sol",
      })),
    ]);
    const final = await readLastAttendant(paths);
    expect(final?.sessionId).toBe("0199-native");
    expect(final?.sessionIdAuthority).toBe("observed");
    expect(final?.launchId).toBe("abc123def4567890");
    expect(final?.nextCursor).toBe("evt_00042");
    expect(final?.model).toBe("gpt-5.6-sol");
    expect([...(final?.invalidatedSessionIds ?? [])].sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `dead-${i}`).sort(),
    );
  });

  test("the sidecar on disk is always a complete JSON document", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    const target = cursorSidecarPath(paths, "codex");
    const writes = Array.from({ length: 25 }, (_, i) =>
      mutateAttendantSidecar(paths, "codex", (current) => ({
        ...(current ?? { harness: "codex", at: "2026-07-16T09:00:00.000Z" }),
        nextCursor: `evt_${String(i).padStart(5, "0")}`,
      })),
    );
    // Read while the writes are in flight: a torn or half-written file is the
    // failure this test exists to catch.
    const reads = (async () => {
      for (let i = 0; i < 40; i++) {
        try {
          JSON.parse(await readFile(target, "utf8"));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await Promise.all([...writes, reads]);
    const raw = JSON.parse(await readFile(target, "utf8"));
    expect(raw.harness).toBe("codex");
  });

  test("invalidations are bounded, deduplicated, and retained across restart", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    for (let i = 0; i < 12; i++) {
      await recordSessionInvalidation(paths, "codex", `dead-${i}`);
    }
    await recordSessionInvalidation(paths, "codex", "dead-11"); // repeat: no growth
    const final = await readLastAttendant(paths);
    // Bounded to the newest MAX_SESSION_INVALIDATIONS, oldest evicted first.
    expect(final?.invalidatedSessionIds).toEqual(
      Array.from({ length: 8 }, (_, i) => `dead-${i + 4}`),
    );
    // "Across restart" = a fresh read from disk, no shared in-memory state.
    const reread = await readLastAttendant(paths);
    expect(reread?.invalidatedSessionIds).toEqual(final?.invalidatedSessionIds);
  });

  test("a pending pre-open sidecar may omit delivery cursor fields", async () => {
    const paths = sessionPaths(artifact);
    await ensureSessionDirs(paths);
    await recordPendingIdentity(paths, {
      harness: "codex",
      launchId: "abc123def4567890",
      sessionId: "0199-native",
      sessionIdAuthority: "observed",
    });
    const pending = await readLastAttendant(paths);
    expect(pending).toMatchObject({
      harness: "codex",
      sessionId: "0199-native",
      sessionIdAuthority: "observed",
      launchId: "abc123def4567890",
      pendingBinding: true,
    });
    expect(pending?.nextCursor).toBeUndefined();
  });
});

describe("the CLI's own stamps carry launch identity from the environment", () => {
  test("an ack written by the CLI carries launchId and authority", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    // The CLI is its own process; the stamp fields ride the environment the
    // spawner exported (runSpawn), so the test hands them the same way.
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "..", "src", "cli", "main.ts"),
        "intent",
        artifact,
        "reply",
      ],
      {
        env: {
          ...process.env,
          LUCID_HARNESS: "codex",
          LUCID_SESSION_ID: "0199-native",
          LUCID_SESSION_ID_AUTHORITY: "observed",
          LUCID_LAUNCH_ID: "abc123def4567890",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    const { events } = await readEvents(paths.logPath);
    const ack = events.findLast((e) => e.t === "agent_ack");
    expect(ack && "attendant" in ack ? ack.attendant : undefined).toMatchObject({
      harness: "codex",
      launchId: "abc123def4567890",
      sessionId: "0199-native",
      sessionIdAuthority: "observed",
    });
  }, 20_000);
});

describe("pending binding promotion (identity before the log exists)", () => {
  const identity = {
    harness: "codex",
    launchId: "abc123def4567890",
    sessionId: "0199-native",
    sessionIdAuthority: "observed",
  } as const;

  test("promotion appends the binding right after session_opened, once", async () => {
    const paths = sessionPaths(artifact);
    await ensureSessionDirs(paths);
    await recordPendingIdentity(paths, identity);

    // BEFORE open there is nothing to promote into: refused, not misfiled.
    expect(await promotePendingBindings(paths)).toEqual([]);

    await openSession(paths);
    const promoted = await promotePendingBindings(paths);
    expect(promoted.length).toBe(1);

    const { events } = await readEvents(paths.logPath);
    // A fresh review log still begins with session_opened...
    expect(events[0]?.t).toBe("session_opened");
    // ...and the binding lands immediately after it, in seq order.
    expect(events[1]).toMatchObject({
      t: "harness_session_bound",
      launchId: identity.launchId,
      attendant: {
        harness: "codex",
        sessionId: "0199-native",
        sessionIdAuthority: "observed",
      },
    });
    expect(foldLog(events).bindings.length).toBe(1);

    // The sidecar keeps the identity but no longer owes the log a binding.
    const after = await readLastAttendant(paths);
    expect(after?.pendingBinding).toBeUndefined();
    expect(after?.sessionId).toBe("0199-native");

    // Promotion is idempotent: run again, nothing new lands.
    expect(await promotePendingBindings(paths)).toEqual([]);
    const again = await readEvents(paths.logPath);
    expect(again.events.filter((e) => e.t === "harness_session_bound").length).toBe(1);
  });

  test("re-discovering the same identity dedupes instead of stuttering the log", async () => {
    const paths = sessionPaths(artifact);
    await ensureSessionDirs(paths);
    await openSession(paths);
    await recordPendingIdentity(paths, identity);
    await promotePendingBindings(paths);
    // The same launch announces the same thread again (a resume confirming).
    await recordPendingIdentity(paths, identity);
    await promotePendingBindings(paths);
    const { events } = await readEvents(paths.logPath);
    expect(events.filter((e) => e.t === "harness_session_bound").length).toBe(1);
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
    await mergeAttendantSidecar(zetaPaths, {
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

describe("a session folder never colonises someone else's directory", () => {
  test("refuses when <stem>/ already exists and is not a Lucid session", async () => {
    // The record is named after its artifact, so `plan.html` claims `plan/`.
    // A human may already keep a `plan/` folder right there - writing a log, a
    // versions tree and a `*` .gitignore into it would bury their files and
    // take them out of git without a word.
    const paths = sessionPaths(artifact);
    await mkdir(paths.sessionDir, { recursive: true });
    await writeFile(join(paths.sessionDir, "notes.md"), "mine", "utf8");

    await expect(openSession(paths)).rejects.toThrow(/not a Lucid session/);
    // Untouched: no log, no ignore file, their file still there.
    expect(existsSync(paths.logPath)).toBe(false);
    expect(existsSync(join(paths.sessionDir, ".gitignore"))).toBe(false);
    expect(await readFile(join(paths.sessionDir, "notes.md"), "utf8")).toBe("mine");
  });

  test("an EMPTY directory of that name is fine to adopt", async () => {
    const paths = sessionPaths(artifact);
    await mkdir(paths.sessionDir, { recursive: true });
    await openSession(paths);
    expect(existsSync(paths.logPath)).toBe(true);
  });

  test("reopening its own session folder is not a collision", async () => {
    const paths = sessionPaths(artifact);
    await openSession(paths);
    await openSession(paths);
    expect(existsSync(paths.logPath)).toBe(true);
  });
});

describe(".lucid is never a project (live review)", () => {
  /**
   * The canonical layout puts the artifact at `<project>/.lucid/<name>.html`,
   * so the no-checkout fallback landed on the artifact's own directory - which
   * IS `.lucid` - and the listing grouped those reviews under a heading naming
   * Lucid's own plumbing instead of the human's work.
   */
  test("a project without a checkout is the folder ABOVE .lucid", async () => {
    const { projectRoot } = await import("../src/core/sessions.ts");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-proj-")));
    await mkdir(join(dir, "artifacts", ".lucid"), { recursive: true });
    const artifact = join(dir, "artifacts", ".lucid", "plan.html");
    await writeFile(artifact, V1);

    expect(await projectRoot(sessionPaths(artifact))).toBe(join(dir, "artifacts"));
    await rm(dir, { recursive: true, force: true });
  });

  test("a checkout still wins over the folder walk", async () => {
    const { projectRoot } = await import("../src/core/sessions.ts");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-proj-")));
    await mkdir(join(dir, "repo", ".git"), { recursive: true });
    await mkdir(join(dir, "repo", ".lucid"), { recursive: true });
    const artifact = join(dir, "repo", ".lucid", "plan.html");
    await writeFile(artifact, V1);

    expect(await projectRoot(sessionPaths(artifact))).toBe(join(dir, "repo"));
    await rm(dir, { recursive: true, force: true });
  });

  test("an artifact NOT in a .lucid folder keeps its own directory", async () => {
    const { projectRoot } = await import("../src/core/sessions.ts");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-proj-")));
    await mkdir(join(dir, "loose"), { recursive: true });
    const artifact = join(dir, "loose", "plan.html");
    await writeFile(artifact, V1);

    expect(await projectRoot(sessionPaths(artifact))).toBe(join(dir, "loose"));
    await rm(dir, { recursive: true, force: true });
  });
});
