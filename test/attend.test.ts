import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../src/core/events.ts";
import { appendEvent, readEvents } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { openSession } from "../src/core/session.ts";
import type { HarnessInfo, SelectionResponse } from "../src/protocol/wire.ts";
import {
  resetPresenceCache,
  resetProcessLister,
  resetSessionCwdCache,
  setProcessLister,
} from "../src/core/presence.ts";
import { applyUnitEnv } from "./unit-env.ts";
import { attendDecision, createAttendant, pendingHumanSeqs } from "../src/server/attend.ts";
import { runDaemon, sessionId, type DaemonHandle } from "../src/server/daemon.ts";
import { createSessionHost } from "../src/server/session-host.ts";

const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

const elementTarget = {
  kind: "element" as const,
  lucidId: "h",
  fingerprint: "f",
  domPath: "h1",
  snippet: "Hello",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for a stub harness to write its marker, or give up. */
/**
 * 30s, not 10: the stub is a real `bun` process, and the whole suite spawns
 * dozens of them. Under load a cold start alone can eat several seconds, which
 * made these three tests fail intermittently on a busy machine while passing
 * every time in isolation - flakiness that says nothing about the code.
 */
const readMarker = async (path: string, timeoutMs = 30_000): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) return (await file.json()) as Record<string, unknown>;
    await sleep(50);
  }
  throw new Error(`stub harness never wrote ${path}`);
};

/** A stand-in harness: records the argv, identity env and cwd it was given. */
const writeStub = async (scriptPath: string, markerPath: string): Promise<void> => {
  await writeFile(
    scriptPath,
    `await Bun.write(${JSON.stringify(markerPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  harness: process.env.LUCID_HARNESS ?? null,
  sessionId: process.env.LUCID_SESSION_ID ?? null,
  requestId: process.env.LUCID_REQUEST_ID ?? null,
  cwd: process.cwd(),
}));
`,
  );
};

describe("attendDecision", () => {
  const base = {
    pendingFeedbackSeqs: [7],
    listening: 0,
    workingSince: undefined,
    firstPendingAt: 1000,
    now: 9000,
    inFlight: false,
    debounceMs: 3000,
    workingGraceMs: 600_000,
  };

  test("spawns when feedback is pending, nothing listens, and the batch settled", () => {
    expect(attendDecision(base)).toBe("spawn");
  });

  test("is idle with no pending feedback", () => {
    expect(attendDecision({ ...base, pendingFeedbackSeqs: [] })).toBe("idle");
  });

  test("waits while an interactive attendant is listening", () => {
    expect(attendDecision({ ...base, listening: 1 })).toBe("wait");
  });

  test("waits until the debounce window elapses", () => {
    expect(attendDecision({ ...base, now: base.firstPendingAt + 2999 })).toBe("wait");
    expect(attendDecision({ ...base, now: base.firstPendingAt + 3000 })).toBe("spawn");
  });

  test("waits while a turn it started is still in flight", () => {
    expect(attendDecision({ ...base, inFlight: true })).toBe("wait");
  });

  test("waits when the batch has not been clocked yet", () => {
    expect(attendDecision({ ...base, firstPendingAt: undefined })).toBe("wait");
  });

  test("waits while an agent that took delivery is still working", () => {
    // The gap the listener count cannot see: the interactive agent acked and
    // its `wait` process exited, so nothing is listening while it edits.
    expect(attendDecision({ ...base, workingSince: base.now - 60_000 })).toBe("wait");
  });

  test("delivers once an unrefreshed working window goes stale", () => {
    // An agent that acked and died must not silence the hub forever.
    expect(attendDecision({ ...base, workingSince: base.now - 600_001 })).toBe("spawn");
  });

  test("pendingHumanSeqs counts human feedback past the delivered cursor only", () => {
    const events = [
      { seq: 1, t: "session_opened" },
      { seq: 2, t: "annotation" },
      { seq: 3, t: "version" },
      { seq: 4, t: "prompt" },
      { seq: 5, t: "agent_ack" },
      { seq: 6, t: "question_answered" },
      { seq: 7, t: "agent_reply" },
      // A fork asks for a NEW artifact - the launcher's job, not a revise turn
      // the hub can drive, so it is never counted as the hub's to deliver.
      { seq: 8, t: "fork" },
      { seq: 9, t: "revert" },
    ] as unknown as readonly LogEvent[];
    expect(pendingHumanSeqs(events, 0)).toEqual([2, 4, 6, 9]);
    expect(pendingHumanSeqs(events, 6)).toEqual([9]);
    expect(pendingHumanSeqs(events, 9)).toEqual([]);
  });
});

describe("session host presence", () => {
  let dir: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-presence-"));
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths);
  });
  afterEach(async () => {
    // Unconditional, and not only in the fixture's own teardown: the stub is
    // installed before the `try` that undoes it, so anything throwing in
    // between leaves it in place - and `bun test` shares one process across
    // files, so a leaked stub reports every pid as `other` and turns presence
    // detection off for the rest of the run, silently.
    resetProcessLister();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A real running process, reported to the liveness check under a
   * harness-like name.
   *
   * The pid is genuine - a plain `sleep`, actually running, actually reaped -
   * so "this pid is alive" stays a real observation. Only the NAME `ps` would
   * report is substituted.
   *
   * This used to copy `/bin/sleep` to `claude-testproc` and execute the copy,
   * because `comm` comes from the executed file's name and that is the only way
   * to make a real process answer to "claude". A copied platform binary fails
   * macOS code signature validation: the process is SIGKILLed, and enough
   * repetitions crash `syspolicyd`, which then throttles and stops NEW
   * APPLICATIONS LAUNCHING machine-wide. That cost this project two hard
   * restarts before the suite was identified as the cause. Nothing in `test/`
   * may copy a signed platform binary.
   */
  const spawnHarnessLike = async (
    _dir: string,
  ): Promise<{ pid: number; kill: () => Promise<void> }> => {
    // Short-lived by construction, and AWAITED on teardown: an unawaited
    // subprocess keeps a handle on bun's loop, which held this file open for
    // the fixture's full lifetime and starved every timing-sensitive test
    // after it.
    const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    const restore = setProcessLister(async (pids) =>
      pids.map((pid) => `${pid} ${pid === proc.pid ? "claude-testproc" : "other"}`).join("\n"),
    );
    return {
      pid: proc.pid,
      kill: async () => {
        restore();
        proc.kill();
        await proc.exited;
      },
    };
  };

  test("state reports the attending conversation as OPEN when it is running", async () => {
    // Everything the panel's interactive mode hangs on: the harness comes from
    // the LOG's stamp (this artifact has no cursor sidecar - a fresh one never
    // does), and presence is joined to it by session id. Getting either wrong
    // left the panel offering to drive a conversation somebody was sitting in.
    const id = "dddddddd-0000-4000-8000-000000000001";
    const artifact = join(dir, "stamped.html");
    await writeFile(artifact, DOC);
    const stampedPaths = sessionPaths(artifact);
    await openSession(stampedPaths, {
      attendant: { harness: "claude-code", sessionId: id, cwd: dir },
    });

    const sessionsDir = join(dir, "claude-sessions");
    await mkdir(sessionsDir, { recursive: true });
    process.env.LUCID_CLAUDE_SESSIONS = sessionsDir;
    const proc = await spawnHarnessLike(dir);
    await writeFile(
      join(sessionsDir, `${proc.pid}.json`),
      JSON.stringify({ pid: proc.pid, sessionId: id, kind: "interactive", status: "idle" }),
    );
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-claude-projects");
    resetPresenceCache();
    resetSessionCwdCache();

    const host = createSessionHost(stampedPaths, { getPort: () => 0, onEnded: () => {} });
    try {
      const res = await host.handle(
        new Request("http://127.0.0.1/__lucid/state", { headers: { host: "127.0.0.1" } }),
      );
      const body = (await res.json()) as {
        attendantPresence?: { interactive: boolean; status?: string };
        lastAttendant?: { harness: string };
      };
      expect(body.attendantPresence?.interactive).toBe(true);
      expect(body.attendantPresence?.status).toBe("idle");
      // Named from the log stamp, with no sidecar in sight.
      expect(body.lastAttendant?.harness).toBe("claude-code");
    } finally {
      host.stop();
      await proc.kill();
      // Same defect as the `afterEach` blocks below, in a `finally`: assigning
      // a path here left it pointed at a directory this test's teardown removes.
      applyUnitEnv();
      resetPresenceCache();
      resetSessionCwdCache();
    }
  });

  test("state reports no presence once that conversation is gone", async () => {
    const id = "dddddddd-0000-4000-8000-000000000002";
    const artifact = join(dir, "closed.html");
    await writeFile(artifact, DOC);
    const stampedPaths = sessionPaths(artifact);
    await openSession(stampedPaths, {
      attendant: { harness: "claude-code", sessionId: id, cwd: dir },
    });
    const sessionsDir = join(dir, "claude-sessions-empty");
    await mkdir(sessionsDir, { recursive: true });
    process.env.LUCID_CLAUDE_SESSIONS = sessionsDir;
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-claude-projects");
    resetPresenceCache();
    resetSessionCwdCache();

    const host = createSessionHost(stampedPaths, { getPort: () => 0, onEnded: () => {} });
    try {
      const res = await host.handle(
        new Request("http://127.0.0.1/__lucid/state", { headers: { host: "127.0.0.1" } }),
      );
      const body = (await res.json()) as { attendantPresence?: unknown };
      expect(body.attendantPresence).toBeUndefined();
    } finally {
      host.stop();
      // Same defect as the `afterEach` blocks below, in a `finally`: assigning
      // a path here left it pointed at a directory this test's teardown removes.
      applyUnitEnv();
      resetPresenceCache();
      resetSessionCwdCache();
    }
  });

  test("agentsListening exposes the agents blocked in wait", async () => {
    const host = createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });
    try {
      expect(host.agentsListening()).toBe(0);
      const req = new Request("http://127.0.0.1/__lucid/events?role=agent", {
        headers: { host: "127.0.0.1" },
      });
      const res = await host.handle(req);
      expect(host.agentsListening()).toBe(1);
      await res.body?.cancel();
      expect(host.agentsListening()).toBe(0);
    } finally {
      host.stop();
    }
  });
});

describe("hub attend mode", () => {
  let dir: string;
  let root: string;
  let proj: string;
  let registryPath: string;
  let harnessesPath: string;
  let attendMarker: string;
  let createMarker: string;
  let artifact: string;
  let paths: SessionPaths;
  let daemon: DaemonHandle | undefined;
  const logs: string[] = [];

  const post = (port: number, path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    logs.length = 0;
    dir = await mkdtemp(join(tmpdir(), "lucid-attend-"));
    root = join(dir, "tree");
    proj = join(root, "proj");
    await mkdir(proj, { recursive: true });
    registryPath = join(dir, "registry.json");
    // Hermetic: without this the daemon also scans the folders the human
    // added to their OWN shell (`~/.lucid/roots.json`), on top of this tree.
    process.env.LUCID_ROOTS = join(dir, "roots.json");
    process.env.LUCID_CLAUDE_SESSIONS = join(dir, "no-claude-sessions");
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-claude-projects");
    resetPresenceCache();
    resetSessionCwdCache();
    harnessesPath = join(dir, "harnesses.json");
    attendMarker = join(dir, "attend-marker.json");
    createMarker = join(dir, "create-marker.json");
    const attendStub = join(dir, "stub-attend.ts");
    const createStub = join(dir, "stub-create.ts");
    await writeStub(attendStub, attendMarker);
    await writeStub(createStub, createMarker);
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "stub",
        harnesses: {
          stub: {
            spawn: [process.execPath, "run", createStub, "{id}", "{artifact}", "{prompt}"],
            resume: [process.execPath, "run", attendStub, "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );

    artifact = join(proj, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    // Born in a "stub" harness session: the association the attend engine
    // resumes (D18 stamps -> fold.sessionHistory).
    await openSession(paths, {
      attendant: { harness: "stub", sessionId: "sess-1", cwd: paths.artifactDir },
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    // Restored, not deleted. This block used to ASSIGN a path here, so the
    // variable outlived the describe that owned it while pointing at a
    // directory the next line removes. Deleting was the fix while nothing owned
    // the baseline; `test/preload.ts` owns it now, and a delete would strip the
    // containment itself and point whatever runs next at the developer's home.
    applyUnitEnv();
    resetPresenceCache();
    resetSessionCwdCache();
    await rm(dir, { recursive: true, force: true });
  });

  const startDaemon = async (attend: boolean, debounceMs = 50): Promise<DaemonHandle> => {
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      harnessesPath,
      attendDebounceMs: debounceMs,
      attendPollMs: 50,
      log: (m) => logs.push(m),
      ...(attend ? { attend: true } : {}),
    });
    return daemon;
  };

  /** Mount the session in the hub (the watcher lives on the mount) and let its
   *  first pass adopt the current high seq as delivered. */
  const mount = async (hub: DaemonHandle): Promise<void> => {
    const id = sessionId(paths.artifactPath);
    const mounted = await fetch(`http://127.0.0.1:${hub.port}/s/${id}/__lucid/identity`, {
      headers: { host: `127.0.0.1:${hub.port}` },
    });
    expect(mounted.status).toBe(200);
    await sleep(300);
  };

  const logEvents = async (): Promise<readonly LogEvent[]> =>
    (await readEvents(paths.logPath)).events;

  test("re-drives a batch whose delivery claim went unanswered", async () => {
    // Delivery is recorded BEFORE the turn runs, so a turn that dies leaves an
    // ack covering feedback nothing acted on. In-process that batch is
    // retried; across a restart only the ack survived, and the message sat
    // marked "delivered" forever. A fresh watcher must notice and re-drive it.
    const annotation = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-stranded",
      version: 1,
      target: elementTarget,
      note: "this must not be swallowed",
    });
    // The claim, with no agent output after it: exactly what a crashed turn
    // leaves behind.
    await appendEvent(paths.logPath, { t: "agent_ack", id: "ack-dead", covers: annotation.seq });

    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      // The claim is already older than this by the time the first tick runs.
      workingGraceMs: 1,
      log: (m) => logs.push(m),
    });
    try {
      await sleep(30);
      // Two ticks: the first adopts the cursor (rolling the stale claim back)
      // and evaluates, the second covers the debounce having just started.
      await attendant.tick();
      await sleep(60);
      await attendant.tick();
      const marker = await readMarker(attendMarker, 4000);
      expect(marker.sessionId).toBe("sess-1");
      expect((marker.argv as string[])[2]).toContain("this must not be swallowed");
      expect(logs.some((l) => l.includes("delivery claim went unanswered"))).toBe(true);
    } finally {
      attendant.stop();
    }
  });

  test("re-drives even after SEVERAL failed attempts on the same batch", async () => {
    // What made this permanent in practice: every failed attempt records its
    // own ack covering the SAME batch. Rolling back to "the previous ack" then
    // lands on the current mark, the rollback cannot fire, and the feedback is
    // pinned at "delivered" behind an indicator that never clears. The rollback
    // has to target the last batch some turn actually ANSWERED.
    const annotation = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-retried",
      version: 1,
      target: elementTarget,
      note: "three dead turns must not swallow this",
    });
    for (const id of ["ack-dead-1", "ack-dead-2", "ack-dead-3"]) {
      await appendEvent(paths.logPath, { t: "agent_ack", id, covers: annotation.seq });
    }

    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      workingGraceMs: 1,
      log: (m) => logs.push(m),
    });
    try {
      await sleep(30);
      await attendant.tick();
      await sleep(60);
      await attendant.tick();
      const marker = await readMarker(attendMarker, 4000);
      expect((marker.argv as string[])[2]).toContain("three dead turns must not swallow this");
    } finally {
      attendant.stop();
    }
  });

  test("a turn that changes nothing still answers, in its own words", async () => {
    // The dead end this closes: a resume that decides there is nothing to do
    // says so on stdout and exits clean, writing no version and no reply. The
    // panel then held "picked up your feedback - no response yet" forever on a
    // turn that had, in fact, answered.
    const quietStub = join(dir, "stub-quiet.ts");
    await writeFile(
      quietStub,
      'console.log("Nothing to change - that note asks me to ignore it.");\n',
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "stub",
        harnesses: {
          stub: {
            spawn: [process.execPath, "run", quietStub],
            resume: [process.execPath, "run", quietStub],
          },
        },
      }),
    );
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-quiet",
      version: 1,
      target: elementTarget,
      note: "this is just a test, ignore it",
    });

    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      log: (m) => logs.push(m),
    });
    try {
      const deadline = Date.now() + 10_000;
      let reply: LogEvent | undefined;
      while (Date.now() < deadline && !reply) {
        await attendant.tick();
        await sleep(120);
        reply = (await readEvents(paths.logPath)).events.find((e) => e.t === "agent_reply");
      }
      expect(reply).toBeDefined();
      expect((reply as { text?: string }).text).toContain("asks me to ignore it");
    } finally {
      attendant.stop();
    }
    // A real harness process has to start, print and exit; the default 5s
    // per-test budget is not enough on a cold bun.
  }, 20_000);

  test("delivers an undelivered batch by resuming the artifact's own session", async () => {
    const hub = await startDaemon(true);
    await mount(hub);

    const annotation = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a1",
      version: 1,
      target: elementTarget,
      note: "backfill must run first",
    });

    const marker = await readMarker(attendMarker);
    expect(marker.harness).toBe("stub");
    expect(marker.sessionId).toBe("sess-1");
    // Resume is cwd-scoped (D10): the session's recorded directory.
    expect(marker.cwd).toBe(realpathSync(paths.artifactDir));
    const argv = marker.argv as string[];
    expect(argv[0]).toBe("sess-1");
    expect(argv[1]).toBe(paths.artifactPath);
    expect(argv[2]).toContain("backfill must run first");

    // The delivery is RECORDED before it is made (D20): the panel says
    // "delivered" for the whole headless turn, and any other watcher reading
    // the log can see the batch is taken. The stamp is the artifact's own
    // session, not the hub's.
    const ack = (await logEvents()).find((e) => e.t === "agent_ack");
    expect(ack).toBeDefined();
    if (ack?.t !== "agent_ack") throw new Error("unreachable");
    expect(ack.covers).toBeGreaterThanOrEqual(annotation.seq);
    expect(ack.intent).toBe("revise");
    expect(ack.attendant?.sessionId).toBe("sess-1");
  }, 20_000);

  test("does not re-deliver a batch an interactive agent already acked", async () => {
    // The normal interactive loop, and the failure it used to cause: the
    // agent's `wait` returns, it acks, its CLI process exits (so NOTHING is
    // listening) and it spends the next minutes editing. A hub that only
    // counted listeners drove a second turn into the same session.
    const hub = await startDaemon(true, 400);
    await mount(hub);

    const annotation = await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a1",
      version: 1,
      target: elementTarget,
      note: "an interactive agent is taking this",
    });
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: "ack-1",
      covers: annotation.seq,
      attendant: { harness: "stub", sessionId: "sess-1" },
    });

    await sleep(1500);
    expect(await Bun.file(attendMarker).exists()).toBe(false);
  }, 20_000);

  test("does not spawn anything without the attend opt-in", async () => {
    const hub = await startDaemon(false);
    const id = sessionId(paths.artifactPath);
    await fetch(`http://127.0.0.1:${hub.port}/s/${id}/__lucid/identity`, {
      headers: { host: `127.0.0.1:${hub.port}` },
    });
    await sleep(200);
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a1",
      version: 1,
      target: elementTarget,
      note: "no hub should act on this",
    });
    await sleep(600);
    expect(await Bun.file(attendMarker).exists()).toBe(false);
  });

  test("POST /hub/create is 403 unless the hub opted into attend mode", async () => {
    const hub = await startDaemon(false);
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "new-plan.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(403);
    expect(await Bun.file(createMarker).exists()).toBe(false);
  });

  test("POST /hub/create rejects a name that is not a plain .html basename", async () => {
    const hub = await startDaemon(true);
    for (const name of ["../escape.html", "notes.txt", "sub/dir.html", ".hidden.html", ""]) {
      const res = await post(hub.port, "/hub/create", { project: proj, name, prompt: "x" });
      expect(res.status).toBe(400);
    }
  });

  test("POST /hub/create rejects a project the listing does not know", async () => {
    const hub = await startDaemon(true);
    const res = await post(hub.port, "/hub/create", {
      project: join(dir, "elsewhere"),
      name: "new-plan.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown project");
  });

  test("POST /hub/create refuses a listed project whose folder is gone", async () => {
    // Listed is not PRESENT. A scratchpad session's project is recovered from
    // the encoded cwd in its path, and that directory can be gone - an
    // ephemeral worktree deleted once its work landed. The review still lists
    // (correctly, under the project it was about), but authoring into it would
    // mkdir -p a tree nobody asked for.
    const vanished = join(dir, "vanished-project");
    const encoded = vanished.replaceAll("/", "-").replaceAll(".", "-");
    const pad = join(
      root,
      "claude-501",
      encoded,
      "40c9c345-b638-4286-bfce-796d9e6fad98",
      "scratchpad",
    );
    await mkdir(join(pad, ".lucid", "old-plan"), { recursive: true });
    await writeFile(
      join(pad, ".lucid", "old-plan", "log.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        t: "session_opened",
        segment: 1,
        version: 1,
        artifact: "old-plan.html",
        hash: "h",
        path: "versions/s1/v1.html",
      })}\n`,
    );

    const hub = await startDaemon(true);
    // Listed, and listed under the vanished project - that is the premise.
    const listed = (await (
      await fetch(`http://127.0.0.1:${hub.port}/hub/sessions`, {
        headers: { host: `127.0.0.1:${hub.port}` },
      })
    ).json()) as { sessions: Array<{ project: string }> };
    expect(listed.sessions.some((s) => s.project === vanished)).toBe(true);

    const res = await post(hub.port, "/hub/create", {
      project: vanished,
      name: "new-plan.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no longer exists");
    expect(await Bun.file(createMarker).exists()).toBe(false);
  });

  test("POST /hub/create rejects an empty or oversized prompt", async () => {
    const hub = await startDaemon(true);
    const empty = await post(hub.port, "/hub/create", {
      project: proj,
      name: "new-plan.html",
      prompt: "   ",
    });
    expect(empty.status).toBe(400);
    const huge = await post(hub.port, "/hub/create", {
      project: proj,
      name: "new-plan.html",
      prompt: "x".repeat(4001),
    });
    expect(huge.status).toBe(400);
  });

  test("POST /hub/create refuses to overwrite an existing artifact", async () => {
    const hub = await startDaemon(true);
    // In `.lucid/`, which is where create now writes (plan 05, M3.2) - the
    // existence check has to look at the path it is about to author.
    await mkdir(join(proj, ".lucid"), { recursive: true });
    await writeFile(join(proj, ".lucid", "taken.html"), DOC);
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "taken.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(409);
  });

  test("POST /hub/create refuses to write through a dangling symlink", async () => {
    const hub = await startDaemon(true);
    // stat() reports a dangling link as absent; creating "into" it would put
    // the artifact wherever the link points, outside the approved project.
    await mkdir(join(proj, ".lucid"), { recursive: true });
    await symlink(join(dir, "elsewhere", "gone.html"), join(proj, ".lucid", "linked.html"));
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "linked.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(409);
    expect(await Bun.file(createMarker).exists()).toBe(false);
  });

  test("POST /hub/create rejects an explicitly named harness the registry lacks", async () => {
    const hub = await startDaemon(true);
    // Falling back to the default here would author with a different agent
    // than the one the human chose.
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "new-plan.html",
      prompt: "map the migration",
      harness: "not-installed",
    });
    expect(res.status).toBe(400);
    expect(await Bun.file(createMarker).exists()).toBe(false);
  });

  test("POST /hub/create answers one request when two ask for the same path", async () => {
    const hub = await startDaemon(true);
    const body = { project: proj, name: "new-plan.html", prompt: "map the migration" };
    // The artifact does not exist until the agent writes it, so the existence
    // check cannot see an authoring run already under way.
    const [a, b] = await Promise.all([
      post(hub.port, "/hub/create", body),
      post(hub.port, "/hub/create", body),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([202, 409]);
  }, 20_000);

  test("a live create turn broadcasts create-progress - the POSITIVE signal (M2.1)", async () => {
    // A stub that takes its time, so "still running" has a window to be
    // observed in. The dialog's old two-minute accusation existed precisely
    // because nothing said this.
    const slowStub = join(dir, "stub-slow.ts");
    await writeFile(
      slowStub,
      `await new Promise((r) => setTimeout(r, 2500));
await Bun.write(${JSON.stringify(createMarker)}, "done");
`,
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "slow",
        harnesses: {
          slow: { spawn: [process.execPath, "run", slowStub, "{id}", "{artifact}", "{prompt}"] },
        },
      }),
    );
    const hub = await startDaemon(true);

    const reader = (
      await fetch(`http://127.0.0.1:${hub.port}/hub/events`, {
        headers: { host: `127.0.0.1:${hub.port}` },
      })
    ).body?.getReader();
    const decoder = new TextDecoder();

    await post(hub.port, "/hub/create", {
      project: proj,
      name: "slow.html",
      prompt: "take your time",
    });

    // Read frames until a progress frame for this artifact arrives.
    let buf = "";
    const deadline = Date.now() + 8000;
    let progress: Record<string, unknown> | undefined;
    while (Date.now() < deadline && progress === undefined) {
      const { value, done } = await reader!.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const frame of buf.split("\n\n")) {
        if (!frame.startsWith("event: create-progress")) continue;
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) progress = JSON.parse(line.slice(6)) as Record<string, unknown>;
      }
    }
    await reader!.cancel().catch(() => {});

    expect(progress).toBeDefined();
    expect(progress?.artifact).toBe(join(proj, ".lucid", "slow.html"));
    // The trace joins the progress frame to the click's request record.
    expect(progress?.trace).toMatch(/^[a-f0-9]{16}$/);
    expect(progress?.elapsedMs as number).toBeGreaterThan(0);
  }, 20_000);

  test("the click's request id reaches the spawned turn as LUCID_REQUEST_ID (M1.3)", async () => {
    const hub = await startDaemon(true);
    const res = await fetch(`http://127.0.0.1:${hub.port}/hub/create`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${hub.port}`,
        "content-type": "application/json",
        "x-lucid-request": "beefcafe12345678",
      },
      body: JSON.stringify({ project: proj, name: "traced.html", prompt: "map it" }),
    });
    expect(res.status).toBe(202);

    const marker = await readMarker(createMarker);
    // The spawned turn holds the SAME id the click carried - this is what
    // makes an authoring turn traceable back to the click (D-001).
    expect(marker.requestId).toBe("beefcafe12345678");
  });

  test("POST /hub/create answers 202 and spawns the recipe with a child identity", async () => {
    const hub = await startDaemon(true);
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "new-plan.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; artifact: string };
    expect(body.ok).toBe(true);
    // Into the project's artifact folder (plan 05, M3.2): the prompt tells the
    // agent to `lucid open` this path, and open refuses anything outside it.
    expect(body.artifact).toBe(join(proj, ".lucid", "new-plan.html"));
    // And that path is one `open` ACCEPTS - the assertion F1 was missing. The
    // create route emitting a path its own CLI refuses is exactly how the
    // whole flow shipped dead: the project needs a `.git` for the placement
    // rule to be live here at all, or this asserts nothing.
    await mkdir(join(proj, ".git"), { recursive: true });
    const { canonicalArtifactLocation } = await import("../src/core/paths.ts");
    expect(canonicalArtifactLocation(body.artifact)).toEqual({ ok: true });

    const marker = await readMarker(createMarker);
    expect(marker.harness).toBe("stub");
    expect(marker.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(marker.cwd).toBe(realpathSync(proj));
    const argv = marker.argv as string[];
    expect(argv[1]).toBe(join(proj, ".lucid", "new-plan.html"));
    expect(argv[2]).toContain("map the migration");
    expect(argv[2]).toContain(`lucid open ${join(proj, ".lucid", "new-plan.html")}`);
  }, 20_000);
});

describe("model/effort selection", () => {
  let dir: string;
  let root: string;
  let proj: string;
  let registryPath: string;
  let harnessesPath: string;
  let attendMarker: string;
  let createMarker: string;
  let artifact: string;
  let paths: SessionPaths;
  let daemon: DaemonHandle | undefined;
  const logs: string[] = [];

  /** The stub stands in for claude-code, so the adapter's real flag spellings
   *  and the after-argv[0] placement rule are what the recipe receives. It is
   *  EXECUTABLE (not `bun run <file>`), because inserted flags land at index 1
   *  and would otherwise be read by the interpreter instead of the harness. */
  const writeExecStub = async (scriptPath: string, markerPath: string): Promise<void> => {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(markerPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  harness: process.env.LUCID_HARNESS ?? null,
  sessionId: process.env.LUCID_SESSION_ID ?? null,
  model: process.env.LUCID_MODEL ?? null,
  effort: process.env.LUCID_EFFORT ?? null,
}));
`,
    );
    await chmod(scriptPath, 0o755);
  };

  const req = (port: number, path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
    });

  const selectionUrl = (): string => `/s/${sessionId(paths.artifactPath)}/__lucid/selection`;

  beforeEach(async () => {
    logs.length = 0;
    dir = await mkdtemp(join(tmpdir(), "lucid-sel-"));
    root = join(dir, "tree");
    proj = join(root, "proj");
    await mkdir(proj, { recursive: true });
    registryPath = join(dir, "registry.json");
    // Hermetic: without this the daemon also scans the folders the human
    // added to their OWN shell (`~/.lucid/roots.json`), on top of this tree.
    process.env.LUCID_ROOTS = join(dir, "roots.json");
    process.env.LUCID_CLAUDE_SESSIONS = join(dir, "no-claude-sessions");
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-claude-projects");
    resetPresenceCache();
    resetSessionCwdCache();
    harnessesPath = join(dir, "harnesses.json");
    attendMarker = join(dir, "attend-marker.json");
    createMarker = join(dir, "create-marker.json");
    const attendStub = join(dir, "stub-attend");
    const createStub = join(dir, "stub-create");
    await writeExecStub(attendStub, attendMarker);
    await writeExecStub(createStub, createMarker);
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "claude-code",
        harnesses: {
          "claude-code": {
            spawn: [createStub, "{id}", "{artifact}", "{prompt}"],
            resume: [attendStub, "{id}", "{artifact}", "{prompt}"],
            models: [{ id: "opus-5", label: "Opus 5" }, { id: "sonnet-5" }],
            defaultModel: "opus-5",
            efforts: ["low", "medium", "high", "xhigh", "max"],
          },
        },
      }),
    );

    artifact = join(proj, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "claude-code", sessionId: "sess-1", cwd: paths.artifactDir },
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    // Restored, not deleted. This block used to ASSIGN a path here, so the
    // variable outlived the describe that owned it while pointing at a
    // directory the next line removes. Deleting was the fix while nothing owned
    // the baseline; `test/preload.ts` owns it now, and a delete would strip the
    // containment itself and point whatever runs next at the developer's home.
    applyUnitEnv();
    resetPresenceCache();
    resetSessionCwdCache();
    await rm(dir, { recursive: true, force: true });
  });

  const startDaemon = async (): Promise<DaemonHandle> => {
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      harnessesPath,
      attendDebounceMs: 50,
      attendPollMs: 50,
      attend: true,
      log: (m) => logs.push(m),
    });
    return daemon;
  };

  const mount = async (hub: DaemonHandle): Promise<void> => {
    await req(hub.port, `/s/${sessionId(paths.artifactPath)}/__lucid/identity`);
    await sleep(300);
  };

  const annotate = (note: string): Promise<LogEvent> =>
    appendEvent(paths.logPath, {
      t: "annotation",
      id: "a1",
      version: 1,
      target: elementTarget,
      note,
    });

  test("GET /__lucid/selection reports the harness's vocabulary and an empty pick", async () => {
    const hub = await startDaemon();
    await mount(hub);
    const res = await req(hub.port, selectionUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as SelectionResponse;
    expect(body.harness).toBe("claude-code");
    expect(body.selection).toEqual({});
    expect(body.info?.models?.map((m) => m.id)).toEqual(["opus-5", "sonnet-5"]);
    expect(body.info?.defaultModel).toBe("opus-5");
    expect(body.info?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("POST /__lucid/selection round-trips, and clearing it restores the CLI's defaults", async () => {
    const hub = await startDaemon();
    await mount(hub);
    const saved = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ model: "sonnet-5", effort: "xhigh" }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SelectionResponse).selection).toEqual({
      harness: "claude-code",
      model: "sonnet-5",
      effort: "xhigh",
    });
    // Sticky: it survives on the artifact, not in the mount's memory.
    expect(await Bun.file(paths.selectionPath).json()).toEqual({
      harness: "claude-code",
      model: "sonnet-5",
      effort: "xhigh",
    });
    const cleared = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ model: "default", effort: "default" }),
    });
    expect(((await cleared.json()) as SelectionResponse).selection).toEqual({});
  });

  test("a POST that is not a JSON object is refused, never a silent clear", async () => {
    const hub = await startDaemon();
    await mount(hub);
    await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ model: "sonnet-5", effort: "xhigh" }),
    });
    // Clearing is destructive and every later unattended turn depends on it,
    // so it must be ASKED for: a truncated or bodyless POST is a 400.
    for (const body of [undefined, "", "{not json", '"sonnet-5"']) {
      const res = await req(hub.port, selectionUrl(), {
        method: "POST",
        ...(body ? { body } : {}),
      });
      expect(res.status).toBe(400);
    }
    expect(await Bun.file(paths.selectionPath).json()).toEqual({
      harness: "claude-code",
      model: "sonnet-5",
      effort: "xhigh",
    });
  });

  test("POST /__lucid/selection refuses a pick the registry does not offer", async () => {
    const hub = await startDaemon();
    await mount(hub);
    const badModel = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-sol" }),
    });
    expect(badModel.status).toBe(400);
    expect(((await badModel.json()) as { error: string }).error).toContain("is not in harness");
    const badEffort = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ effort: "ultra" }),
    });
    expect(badEffort.status).toBe(400);
    // Nothing was persisted by a refused pick.
    expect(await Bun.file(paths.selectionPath).exists()).toBe(false);
  });

  test("an unattended resume carries the sticky selection into the recipe's argv", async () => {
    const hub = await startDaemon();
    await mount(hub);
    await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ model: "sonnet-5", effort: "max" }),
    });
    await annotate("use the new schema");

    const marker = await readMarker(attendMarker);
    const argv = marker.argv as string[];
    // Inserted after argv[0], so the recipe's own positional tokens keep their
    // order and the prompt is still the last one.
    expect(argv.slice(0, 4)).toEqual(["--model", "sonnet-5", "--effort", "max"]);
    expect(argv[4]).toBe("sess-1");
    expect(argv[5]).toBe(paths.artifactPath);
    expect(argv[6]).toContain("use the new schema");
    // The child stamps what IT runs, so the viewer shows the real settings.
    expect(marker.model).toBe("sonnet-5");
    expect(marker.effort).toBe("max");
  }, 20_000);

  test("a selection the registry no longer offers is dropped, warned about, and delivered anyway", async () => {
    // The pick was legal when it was made; a human then edited the registry.
    await mkdir(paths.sessionDir, { recursive: true });
    await writeFile(
      paths.selectionPath,
      JSON.stringify({ harness: "claude-code", model: "opus-4.8", effort: "high" }),
    );
    const hub = await startDaemon();
    await mount(hub);
    await annotate("deliver this regardless");

    const marker = await readMarker(attendMarker);
    // Degraded, not stalled: the turn ran on the CLI's own defaults.
    expect(marker.argv).toEqual(["sess-1", paths.artifactPath, expect.any(String)]);
    expect(marker.model).toBeNull();
    expect(logs.some((m) => m.includes("Model/effort selection ignored"))).toBe(true);
  }, 20_000);

  test("POST /hub/create validates, persists and applies the dialog's pick", async () => {
    const hub = await startDaemon();
    const rejected = await req(hub.port, "/hub/create", {
      method: "POST",
      body: JSON.stringify({
        project: proj,
        name: "new-plan.html",
        prompt: "map the migration",
        model: "gpt-5.6-sol",
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await Bun.file(createMarker).exists()).toBe(false);

    const res = await req(hub.port, "/hub/create", {
      method: "POST",
      body: JSON.stringify({
        project: proj,
        name: "new-plan.html",
        prompt: "map the migration",
        model: "opus-5",
        effort: "xhigh",
      }),
    });
    expect(res.status).toBe(202);
    const marker = await readMarker(createMarker);
    expect((marker.argv as string[]).slice(0, 4)).toEqual([
      "--model",
      "opus-5",
      "--effort",
      "xhigh",
    ]);
    expect(marker.model).toBe("opus-5");
    // The pick STICKS: the new artifact's later unattended turns reuse it.
    const child = sessionPaths(join(proj, ".lucid", "new-plan.html"));
    expect(await Bun.file(child.selectionPath).json()).toEqual({
      harness: "claude-code",
      model: "opus-5",
      effort: "xhigh",
    });
  }, 20_000);

  test("GET /hub/identity reports harnessInfo beside the unchanged harnesses list", async () => {
    const hub = await startDaemon();
    const body = (await (await req(hub.port, "/hub/identity")).json()) as {
      harnesses: string[];
      harnessInfo: HarnessInfo[];
    };
    expect(body.harnesses).toEqual(["claude-code"]);
    expect(body.harnessInfo).toEqual([
      {
        name: "claude-code",
        models: [{ id: "opus-5", label: "Opus 5" }, { id: "sonnet-5" }],
        defaultModel: "opus-5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
  });
});
