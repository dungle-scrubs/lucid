import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../src/core/events.ts";
import { foldLog } from "../src/core/fold.ts";
import {
  mergeAttendantSidecar,
  readAttendantSidecars,
  readLastAttendant,
} from "../src/core/attendant.ts";
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
  let lastReadError: unknown;
  while (Date.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) {
      try {
        return (await file.json()) as Record<string, unknown>;
      } catch (error) {
        // Bun.write exposes the path before every byte is necessarily visible.
        // Treat a partial JSON marker like an absent marker and keep polling.
        lastReadError = error;
      }
    }
    await sleep(50);
  }
  throw new Error(
    `stub harness never wrote a complete marker at ${path}${
      lastReadError instanceof Error ? `: ${lastReadError.message}` : ""
    }`,
  );
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

  test("a live subscriber counts as activity, so idle timers cannot suspend a watched session", async () => {
    const host = createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });
    try {
      const res = await host.handle(
        new Request("http://127.0.0.1/__lucid/events", { headers: { host: "127.0.0.1" } }),
      );
      const connected = host.lastActivityAt();
      await sleep(25);
      // Advances with no request in between: the open stream IS the activity.
      expect(host.lastActivityAt()).toBeGreaterThan(connected);
      await res.body?.cancel();
      const idle = host.lastActivityAt();
      await sleep(25);
      expect(host.lastActivityAt()).toBe(idle); // static again once nobody watches
    } finally {
      host.stop();
    }
  });

  test("suspend refuses while a subscriber is connected, and reports eviction rightness", async () => {
    const host = createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });
    try {
      const res = await host.handle(
        new Request("http://127.0.0.1/__lucid/events", { headers: { host: "127.0.0.1" } }),
      );
      // The idle owner's check-to-append gap: with a subscriber connected the
      // suspend must refuse, or it closes the stream somebody just opened.
      expect(await host.suspend()).toBe(false);
      let state = foldLog((await readEvents(paths.logPath)).events);
      expect(state.status).toBe("active");
      await res.body?.cancel();
      expect(await host.suspend()).toBe(true);
      state = foldLog((await readEvents(paths.logPath)).events);
      expect(state.status).toBe("suspended");
      // Already suspended: nothing to append, but evicting an unwatched mount
      // on a closed log is still right.
      expect(await host.suspend()).toBe(true);
    } finally {
      host.stop();
    }
  });

  test("a subscriber connecting to a suspended log resumes it and reconciles the artifact", async () => {
    // The overnight loop this heals: idle-suspend evicted the mount, the tab's
    // stream reconnected and remounted, and nothing ever appended
    // session_resumed - so wait reported "paused" and the watcher refused
    // versions at a session a human was actively watching.
    await appendEvent(paths.logPath, { t: "session_suspended" });
    // A revision that landed while the log wrongly said suspended.
    const revised =
      '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello again</h1></body></html>';
    await writeFile(join(dir, "plan.html"), revised);
    // AND the damage the old refuse-after-clobber bug left behind: the serve
    // cache already equals the revised artifact while the log still says v1.
    // A cache comparison reads that as "no change"; the reconcile must judge
    // against committed history to mint the missing version.
    await writeFile(paths.currentHtml, revised);
    const host = createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });
    try {
      await host.handle(
        new Request("http://127.0.0.1/__lucid/events", { headers: { host: "127.0.0.1" } }),
      );
      const deadline = Date.now() + 5000;
      for (;;) {
        const { events } = await readEvents(paths.logPath);
        const resumed = events.some((e) => e.t === "session_resumed");
        const version = events.some((e) => e.t === "version" && e.version === 2);
        if (resumed && version) break;
        if (Date.now() > deadline) {
          throw new Error(`no resume/reconcile: ${events.map((e) => e.t).join(",")}`);
        }
        await sleep(25);
      }
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
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [process.execPath, "run", createStub, "--sid", "{id}", "{artifact}", "{prompt}"],
            resume: [
              process.execPath,
              "run",
              attendStub,
              "--sid",
              "{id}",
              "{artifact}",
              "{prompt}",
            ],
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
    // Automatic resume ranks EVIDENCE, not mentions (plan 03, M4): an untyped
    // log stamp is display-only now, so the fixture records the id the modern
    // way - a sidecar with explicit authority, which is what the attend
    // engine's tier-one candidate reads.
    await mergeAttendantSidecar(paths, {
      harness: "stub",
      sessionId: "sess-1",
      sessionIdAuthority: "declared",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
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
      expect((marker.argv as string[])[3]).toContain("this must not be swallowed");
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
      expect((marker.argv as string[])[3]).toContain("three dead turns must not swallow this");
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

  test("a recorded harness the registry lacks stands the engine down, not the default", async () => {
    // The registry is configured and has a default - just not this artifact's
    // harness. Resuming session id sess-1 under the default would re-enter a
    // DIFFERENT agent's conversation, so the engine says so and stands down.
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "other",
        harnesses: {
          other: {
            spawn: [process.execPath, "--version"],
            resume: [process.execPath, "--version"],
          },
        },
      }),
    );
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-unlisted",
      version: 1,
      target: elementTarget,
      note: "nobody configured here can answer this",
    });

    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      log: (m) => logs.push(m),
    });
    try {
      // Well inside the per-test budget below, so a regression fails on the
      // assertion - which prints the lines the engine DID write - rather than
      // as a bare timeout naming neither the missing line nor the harness.
      const deadline = Date.now() + 5_000;
      const stoodDown = () => logs.some((l) => l.includes('no spawn recipe for harness "stub"'));
      while (Date.now() < deadline && !stoodDown()) {
        await attendant.tick();
        await sleep(60);
      }
      expect(logs.join("\n")).toContain('no spawn recipe for harness "stub"');
      expect(logs.some((l) => l.includes("delivering feedback"))).toBe(false);
    } finally {
      attendant.stop();
    }
    // Nothing spawns here (that is the point), but the loop's own deadline
    // needs room inside the budget - the default 5s is exactly the deadline.
  }, 15_000);

  test("a usage-limited turn ends in chat and stands down after one attempt", async () => {
    // A harness prints its wall on the same line as whatever it was working
    // on. Both consumers of a detection are RETAINED records - the hub log and
    // the viewer's warning - so the line itself can reach neither (D-005).
    const sentinel = "ACQUISITION-OF-NORTHWIND";
    const walledStub = join(dir, "stub-walled.ts");
    await writeFile(
      walledStub,
      `console.log(${JSON.stringify(`You've hit your weekly limit · resets 2am (Asia/Bangkok) ${sentinel}`)});\nprocess.exit(1);\n`,
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "stub",
        harnesses: {
          stub: {
            spawn: [process.execPath, "run", walledStub],
            resume: [process.execPath, "run", walledStub],
          },
        },
      }),
    );
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-walled",
      version: 1,
      target: elementTarget,
      note: "this must not be swallowed by a wall",
    });

    const warnings: Array<{ code: string; message: string }> = [];
    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      log: (m) => logs.push(m),
      warn: (code, message) => warnings.push({ code, message }),
    });
    const deliveries = (): number => logs.filter((l) => l.includes("delivering feedback")).length;
    try {
      const deadline = Date.now() + 10_000;
      let ended: LogEvent | undefined;
      while (Date.now() < deadline && ended === undefined) {
        await attendant.tick();
        await sleep(120);
        ended = (await readEvents(paths.logPath)).events.find(
          (event) => event.t === "agent_turn_ended" && event.reason === "usage_limit",
        );
      }
      if (ended === undefined) {
        throw new Error(
          `no usage-limit turn end\nlogs=${JSON.stringify(logs)}\nevents=${JSON.stringify((await readEvents(paths.logPath)).events)}\noutput=${await readFile(paths.attendLog, "utf8").catch(() => "<missing>")}`,
        );
      }
      expect(ended).toMatchObject({ reason: "usage_limit", code: "weekly_limit" });
      // This is now part of the durable chat state, not a duplicate transient
      // warning below the conversation.
      expect(warnings).toEqual([]);
      // The identifier is what the hub log holds, and the harness's own words
      // are still on disk - so this cannot pass by never having read them.
      expect(logs.some((l) => l.includes("weekly-limit"))).toBe(true);
      expect(logs.some((l) => l.includes(sentinel))).toBe(false);
      expect(await readFile(paths.attendLog, "utf8")).toContain(sentinel);
      // A wall is not a flake: one turn, then the cool-off holds the mount off.
      expect(deliveries()).toBe(1);
      for (let i = 0; i < 3; i += 1) {
        await attendant.tick();
        await sleep(60);
      }
      expect(deliveries()).toBe(1);
    } finally {
      attendant.stop();
    }
  }, 20_000);

  test("a handoff to an identity-free recipe is refused, not handed a minted UUID", async () => {
    // The create paths refuse an identity-free recipe before any process
    // exists (HSI001): an unattended session Lucid cannot resume is a session
    // it should not start. A HANDOFF starts one too - and this path minted a
    // UUID for any non-discovered strategy, identity-free recipes included,
    // which is exactly the synthetic identity that poisoned resume.
    const handoffStub = join(dir, "stub-handoff.ts");
    const handoffMarker = join(dir, "handoff-marker.json");
    await writeStub(handoffStub, handoffMarker);
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "stub",
        harnesses: {
          stub: {
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [process.execPath, "run", handoffStub, "--sid", "{id}", "{artifact}"],
            resume: [process.execPath, "run", handoffStub, "--sid", "{id}", "{artifact}"],
          },
          // Loads for diagnosis, refuses unattended use.
          legacy: { spawn: [process.execPath, "run", handoffStub, "{artifact}"] },
        },
      }),
    );
    // The switch is what makes this a handoff rather than a resume.
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "legacy" }));
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-handoff",
      version: 1,
      target: elementTarget,
      note: "this must not start a session nothing can resume",
    });

    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      log: (m) => logs.push(m),
    });
    try {
      const said = () => logs.some((l) => l.includes("declares no session identity strategy"));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !said()) {
        await attendant.tick();
        await sleep(60);
      }
      expect(said()).toBe(true);
      // Give a wrongly-spawned turn time to run before asserting it never did.
      await sleep(300);
      expect(await Bun.file(handoffMarker).exists()).toBe(false);
    } finally {
      attendant.stop();
    }
  }, 15_000);

  test("an auth-walled turn names the wall in its record, not a bare failure", async () => {
    // A `lucid hub --attend` daemon runs detached from any login session, so
    // it cannot read credentials an interactive `claude login` put in the
    // Keychain: the turn dies on auth while the human is, correctly, logged
    // in. The create path already said which wall that was; the attend path
    // ended with a bare `failed` and no code, so the record said nothing
    // about the one failure logging in again cannot fix.
    const authStub = join(dir, "stub-auth.ts");
    await writeFile(
      authStub,
      'console.error("Failed to authenticate: OAuth session expired");\nprocess.exit(1);\n',
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "stub",
        harnesses: {
          stub: {
            spawn: [process.execPath, "run", authStub],
            resume: [process.execPath, "run", authStub],
          },
        },
      }),
    );
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-auth",
      version: 1,
      target: elementTarget,
      note: "this must not die as an anonymous failure",
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
      let ended: LogEvent | undefined;
      while (Date.now() < deadline && ended === undefined) {
        await attendant.tick();
        await sleep(120);
        ended = (await readEvents(paths.logPath)).events.find((e) => e.t === "agent_turn_ended");
      }
      if (ended === undefined) {
        throw new Error(
          `no turn end\nlogs=${JSON.stringify(logs)}\noutput=${await readFile(paths.attendLog, "utf8").catch(() => "<missing>")}`,
        );
      }
      // Still `failed` - the reason set is closed and an auth wall is not a
      // usage wall - but the code now says WHICH wall it was.
      expect(ended).toMatchObject({ reason: "failed", code: "auth_expired" });
    } finally {
      attendant.stop();
    }
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
    expect(argv[0]).toBe("--sid");
    expect(argv[1]).toBe("sess-1");
    expect(argv[2]).toBe(paths.artifactPath);
    expect(argv[3]).toContain("backfill must run first");

    // The delivery is RECORDED before it is made (D20): the panel says
    // "delivered" for the whole headless turn, and any other watcher reading
    // the log can see the batch is taken. The stamp is the artifact's own
    // session, not the hub's.
    const ack = (await logEvents()).find((e) => e.t === "agent_ack");
    expect(ack).toBeDefined();
    if (ack?.t !== "agent_ack") throw new Error("unreachable");
    expect(ack.covers).toBeGreaterThanOrEqual(annotation.seq);
    // And it declares NO intent. This ack is written BEFORE the turn has read
    // a word, so it cannot know whether the artifact will change - claiming
    // "revise" made the viewer announce "Updating the artifact…" for a "hey"
    // that changed nothing. Intent is the agent's to declare (`lucid intent`)
    // once it has read the feedback and decided; the delivery claim is not a
    // promise about output.
    expect(ack.intent).toBeUndefined();
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

  test("a quiet turn's relayed reply never contains Lucid's own narration (#91 review)", async () => {
    // The WIRING, not the helper: LUCID_VERBOSE propagates into the spawned
    // turn, whose stderr IS the attend log this reply is read from, so a
    // stub that writes only narration must relay NOTHING. Testing the pure
    // filter left the call site free to regress silently.
    const narrator = join(dir, "stub-narrator.ts");
    await writeFile(
      narrator,
      `await Bun.write(process.argv[2] ?? "/dev/null", "");
` +
        `process.stderr.write("[anchors] fingerprint p#ab12 -> 1 match, exact\n");
` +
        `process.stderr.write("[attend] plan: spawn - spawning\n");
`,
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "narrator",
        harnesses: {
          narrator: {
            spawn: [process.execPath, "run", narrator, "{id}", "{artifact}", "{prompt}"],
            resume: [process.execPath, "run", narrator, "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );
    const { relayableTail, relayableReply, codexFinalMessage } = await import(
      "../src/server/attend.ts"
    );
    const onlyNarration = [
      "[anchors] fingerprint p#ab12 -> 1 match, exact",
      "   [attend] plan: spawn - spawning",
    ].join("\n");
    expect(relayableTail(onlyNarration)).toBe("");
    // And the call site really uses it - a revert to the raw tail reds here.
    const src = await readFile(join(import.meta.dir, "..", "src/server/attend.ts"), "utf8");
    expect(src).toContain("const tail = relayableReply(output);");

    // codex framing: the final message is what follows the LAST
    // `tokens used` / `<count>` footer - never the diff echo before it, which
    // is what a byte-slice tail delivered as "the agent's reply".
    const codexRun = [
      "OpenAI Codex v0.145.0",
      "user",
      "Review feedback arrived on plan.html.",
      "codex",
      "Applying the renumbering now.",
      "@@ -1288,7 +1607,7 @@",
      '-        <div class="section-index">10</div>',
      '+        <div class="section-index">11</div>',
      '         <div class="section-title">',
      "",
      "tokens used",
      "319,662",
      "Updated plan.html with the renumbered sections.",
      "",
      "The review stays open.",
    ].join("\n");
    expect(codexFinalMessage(codexRun)).toBe(
      "Updated plan.html with the renumbered sections.\n\nThe review stays open.",
    );
    expect(relayableReply(codexRun)).toBe(
      "Updated plan.html with the renumbered sections.\n\nThe review stays open.",
    );
    // Two appended runs: the LAST footer wins.
    const twoRuns = `${codexRun}\nOpenAI Codex v0.145.0\ncodex\nSecond turn.\ntokens used\n12,004\nReplied in Lucid. No artifact change was needed.`;
    expect(codexFinalMessage(twoRuns)).toBe("Replied in Lucid. No artifact change was needed.");
    const jsonRun = [
      JSON.stringify({ type: "thread.started", thread_id: "019c-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_19",
          type: "agent_message",
          text: "The artifact is outside this writable workspace.",
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 845_455 } }),
    ].join("\n");
    expect(codexFinalMessage(jsonRun)).toBe("The artifact is outside this writable workspace.");
    expect(relayableReply(jsonRun)).toBe("The artifact is outside this writable workspace.");
    expect(
      relayableReply(
        [
          JSON.stringify({ type: "thread.started", thread_id: "019c-thread" }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12 } }),
        ].join("\n"),
      ),
    ).toBe("");
    // A run with no recognizable footer falls back to the bounded tail.
    expect(relayableReply("just some words from a quieter harness")).toBe(
      "just some words from a quieter harness",
    );
    // A spoken "tokens used" with no count line is not a footer.
    expect(codexFinalMessage("we discussed\ntokens used\nby the model earlier")).toBeUndefined();
  });

  test("a live create turn broadcasts create-progress - the POSITIVE signal (M2.1)", async () => {
    // A stub that takes its time, so "still running" has a window to be
    // observed in. The dialog's old two-minute accusation existed precisely
    // because nothing said this.
    const slowStub = join(dir, "stub-slow.ts");
    // The stub narrates a phase the way `lucid progress` does before `lucid
    // open` exists: a direct append to the child session's log, stamped with
    // the child identity runSpawn exported - the heartbeat only relays labels
    // OWNED by the session it spawned, so a leftover process from a deleted
    // artifact of the same name can never narrate this creation. A second,
    // unowned ack proves the filter.
    await writeFile(
      slowStub,
      `const artifact = process.argv[4];
const mine = JSON.stringify({
  t: "agent_ack",
  id: "phase-1",
  progress: { label: "writing the sections" },
  // LAUNCH-owned, deliberately without a session id: a discovered harness has
  // no native id until it announces one, and the heartbeat must still relay
  // the phases of the launch it started.
  attendant: { harness: "slow", launchId: process.env.LUCID_LAUNCH_ID },
  seq: 1,
  at: new Date().toISOString(),
});
const stale = JSON.stringify({
  t: "agent_ack",
  id: "phase-stale",
  progress: { label: "A STALE TURN'S PHASE" },
  attendant: { harness: "slow", sessionId: "00000000-dead-4000-8000-000000000000" },
  seq: 2,
  at: new Date().toISOString(),
});
await Bun.write(artifact.replace(/\\.html$/, "") + "/log.ndjson", mine + "\\n" + stale + "\\n");
await new Promise((r) => setTimeout(r, 4000));
await Bun.write(${JSON.stringify(createMarker)}, "done");
`,
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "slow",
        harnesses: {
          slow: {
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [process.execPath, "run", slowStub, "--sid", "{id}", "{artifact}", "{prompt}"],
          },
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

    // Read frames until a progress frame CARRYING THE STUB'S PHASE LABEL
    // arrives (the first beat can race the stub's cold start, so an unlabeled
    // frame is kept as evidence but the loop reads on).
    let buf = "";
    const deadline = Date.now() + 8000;
    let progress: Record<string, unknown> | undefined;
    let labeled: Record<string, unknown> | undefined;
    while (Date.now() < deadline && labeled === undefined) {
      const { value, done } = await reader!.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Only COMPLETE frames: a chunk boundary mid-frame would otherwise
      // hand JSON.parse a truncated data line and throw instead of retrying.
      const frames = buf.split("\n\n");
      for (const frame of frames.slice(0, -1)) {
        if (!frame.startsWith("event: create-progress")) continue;
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          progress = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (typeof progress.label === "string") labeled = progress;
        }
      }
    }
    expect(progress).toBeDefined();
    expect(progress?.artifact).toBe(join(proj, ".lucid", "slow.html"));
    // The trace joins the progress frame to the click's request record.
    expect(progress?.trace).toMatch(/^[a-f0-9]{16}$/);
    expect(progress?.elapsedMs as number).toBeGreaterThan(0);
    // The turn's own narration rode the heartbeat to the dialog.
    expect(labeled?.label).toBe("writing the sections");

    // And it STOPS when the turn does - a heartbeat nobody clears would beat
    // at nobody for the rest of the process's life, and asserting only that
    // one arrived left `clearInterval` deletable with this test green. So:
    // wait for the turn to finish, then KEEP READING and require silence.
    // Existence, not readMarker: this stub writes plain text, and the marker
    // is only being used as "the turn finished".
    const doneBy = Date.now() + 10_000;
    while (Date.now() < doneBy && !(await Bun.file(createMarker).exists())) await sleep(50);
    expect(await Bun.file(createMarker).exists()).toBe(true);
    let after = "";
    // A beat that FIRED before the turn's cleanup can still be in flight (or
    // sitting in the stream buffer) when the marker appears - drop everything
    // in a short grace window so the silence assertion judges behavior, not
    // socket timing.
    const graceUntil = Date.now() + 1200;
    const quietUntil = graceUntil + 5000;
    // ONE pending read carried across iterations: racing a fresh read against
    // a sleep orphans the loser, and the orphan eats the next chunk - which
    // would make this assertion pass by losing the very frames it looks for.
    let pending: ReturnType<NonNullable<typeof reader>["read"]> | null = null;
    while (Date.now() < quietUntil) {
      if (pending === null) pending = reader!.read();
      const inflight = pending;
      const next = await Promise.race([
        inflight.then((r) => ({ hit: true as const, r })),
        sleep(400).then(() => ({ hit: false as const })),
      ]);
      if (!next.hit) continue;
      pending = null;
      if (next.r.done) break;
      if (next.r.value && Date.now() >= graceUntil) {
        after += decoder.decode(next.r.value, { stream: true });
      }
    }
    expect(after).not.toContain("event: create-progress");
    await reader!.cancel().catch(() => {});
  }, 30_000);

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

  test("a DISCOVERED hub create binds the announced thread, never a pre-minted UUID", async () => {
    // The registry switches to a stdout-jsonl harness: the stub announces its
    // own thread id the way Codex does, and Lucid must bind THAT - handing
    // the child a minted UUID here was the synthetic identity that poisoned
    // resume (the reported EZE failure).
    const discoveredStub = join(dir, "stub-discovered.ts");
    await writeFile(
      discoveredStub,
      `process.stdout.write('{"type":"thread.started","thread_');
await new Promise((r) => setTimeout(r, 20));
process.stdout.write('id":"0199-hub-native"}\\n');
await Bun.write(${JSON.stringify(createMarker)}, JSON.stringify({
  envSid: process.env.LUCID_SESSION_ID ?? null,
  envLaunch: process.env.LUCID_LAUNCH_ID ?? null,
  argv: process.argv.slice(2),
}));
const artifact = process.argv[3];
await Bun.write(artifact, "<!doctype html><html><head><title>d</title></head><body><h1>d</h1></body></html>");
`,
    );
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "disco",
        harnesses: {
          disco: {
            sessionIdentity: {
              event: "thread.started",
              field: "thread_id",
              requiredArgument: "--json",
              source: "stdout-jsonl",
            },
            spawn: [process.execPath, "run", discoveredStub, "--json", "{artifact}", "{prompt}"],
          },
        },
      }),
    );
    const hub = await startDaemon(true);
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "disco.html",
      prompt: "author it",
    });
    expect(res.status).toBe(202);
    const marker = await readMarker(createMarker);
    // No inherited identity reached the child; the launch correlation did.
    expect(marker.envSid).toBeNull();
    expect(marker.envLaunch).toMatch(/^[a-f0-9]{16}$/);
    // The ANNOUNCED thread is waiting in the child's sidecar as a pending
    // binding under this launch - which is everything the child's own
    // `lucid open` needs to make it durable (promotion is pinned in the
    // session suite). This stub deliberately does not open; the full
    // spawn->announce->open->bind chain is the fork integration test's.
    const childPaths = sessionPaths(join(proj, ".lucid", "disco.html"));
    const deadline = Date.now() + 5000;
    let pending: Awaited<ReturnType<typeof readLastAttendant>>;
    while (Date.now() < deadline && pending?.sessionId === undefined) {
      pending = await readLastAttendant(childPaths);
      if (pending?.sessionId === undefined) await sleep(50);
    }
    expect(pending).toMatchObject({
      harness: "disco",
      launchId: marker.envLaunch,
      pendingBinding: true,
      sessionId: "0199-hub-native",
      sessionIdAuthority: "observed",
    });
  }, 20_000);

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
    const { canonicalArtifactLocation } = await import("../src/core/project.ts");
    expect(canonicalArtifactLocation(body.artifact)).toEqual({ ok: true });

    const marker = await readMarker(createMarker);
    expect(marker.harness).toBe("stub");
    expect(marker.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(marker.cwd).toBe(realpathSync(proj));
    const argv = marker.argv as string[];
    expect(argv[0]).toBe("--sid");
    expect(argv[2]).toBe(join(proj, ".lucid", "new-plan.html"));
    expect(argv[3]).toContain("map the migration");
    expect(argv[3]).toContain(`lucid open ${join(proj, ".lucid", "new-plan.html")}`);
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
  cwd: process.cwd(),
  effort: process.env.LUCID_EFFORT ?? null,
  harness: process.env.LUCID_HARNESS ?? null,
  model: process.env.LUCID_MODEL ?? null,
  sessionId: process.env.LUCID_SESSION_ID ?? null,
}));
if (process.env.LUCID_HARNESS === "codex") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-from-output" }));
}
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

  const waitForLatestSession = async (
    predicate: (session: ReturnType<typeof foldLog>["sessionHistory"][number]) => boolean,
  ): Promise<ReturnType<typeof foldLog>["sessionHistory"][number]> => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const latest = foldLog((await readEvents(paths.logPath)).events).sessionHistory.at(-1);
      if (latest && predicate(latest)) return latest;
      await Bun.sleep(10);
    }
    throw new Error("timed out waiting for the replacement harness session stamp");
  };

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
    // A store that HOLDS the fixture conversation: driveTurn pre-flights the
    // local transcript before any resume, so a machine whose store lacks the
    // session refuses the spawn - which is its own test, not this suite's
    // premise. The directory name is deliberately not flattened-path-shaped
    // (existence answers pre-flight; cwd recovery falls back to the record).
    const claudeStore = join(dir, "claude-projects");
    await mkdir(join(claudeStore, "store-a"), { recursive: true });
    await writeFile(join(claudeStore, "store-a", "sess-1.jsonl"), "");
    process.env.LUCID_CLAUDE_PROJECTS = claudeStore;
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
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [createStub, "--sid", "{id}", "{artifact}", "{prompt}"],
            resume: [attendStub, "--sid", "{id}", "{artifact}", "{prompt}"],
            models: [{ id: "opus-5", label: "Opus 5" }, { id: "sonnet-5" }],
            defaultModel: "opus-5",
            efforts: ["low", "medium", "high", "xhigh", "max"],
          },
          codex: {
            // Codex is a DISCOVERED harness for real: the stub announces its
            // thread on stdout exactly as `codex exec --json` does, and that
            // announced id - never a Lucid-minted one - is what resume names.
            sessionIdentity: {
              event: "thread.started",
              field: "thread_id",
              requiredArgument: "--json",
              source: "stdout-jsonl",
            },
            spawn: [createStub, "--json", "{artifact}", "{prompt}"],
            resume: [attendStub, "--json", "{id}", "{artifact}", "{prompt}"],
            models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
            defaultModel: "gpt-5.6-sol",
            efforts: ["medium", "high", "xhigh", "max", "ultra"],
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
    // Evidence, not mention (plan 03, M4): the modern identity record the
    // attend engine's tier-one candidate reads.
    await mergeAttendantSidecar(paths, {
      harness: "claude-code",
      sessionId: "sess-1",
      sessionIdAuthority: "declared",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
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
    expect(body.harnesses?.map((harness) => harness.name)).toEqual(["claude-code", "codex"]);
  });

  test("POST /__lucid/selection switches the vocabulary to another harness", async () => {
    const hub = await startDaemon();
    await mount(hub);
    const switched = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ harness: "codex", model: "gpt-5.6-sol", effort: "xhigh" }),
    });
    expect(switched.status).toBe(200);
    const body = (await switched.json()) as SelectionResponse;
    expect(body.harness).toBe("codex");
    expect(body.info?.defaultModel).toBe("gpt-5.6-sol");
    expect(body.selection).toEqual({
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
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
    expect(argv[4]).toBe("--sid");
    expect(argv[5]).toBe("sess-1");
    expect(argv[6]).toBe(paths.artifactPath);
    expect(argv[7]).toContain("use the new schema");
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
    expect(marker.argv).toEqual(["--sid", "sess-1", paths.artifactPath, expect.any(String)]);
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
    expect(body.harnesses).toEqual(["claude-code", "codex"]);
    expect(body.harnessInfo).toEqual([
      {
        name: "claude-code",
        models: [{ id: "opus-5", label: "Opus 5" }, { id: "sonnet-5" }],
        defaultModel: "opus-5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        name: "codex",
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
        defaultModel: "gpt-5.6-sol",
        efforts: ["medium", "high", "xhigh", "max", "ultra"],
      },
    ]);
  });

  test("switching harness starts a fresh session with the full Lucid record", async () => {
    const hub = await startDaemon();
    await mount(hub);
    await appendEvent(paths.logPath, {
      t: "agent_reply",
      id: "prior-reply",
      text: "The earlier answer that the next harness must inherit.",
      attendant: { harness: "claude-code", sessionId: "sess-1", cwd: paths.artifactDir },
    });
    const switched = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ harness: "codex", model: "gpt-5.6-sol", effort: "high" }),
    });
    expect(switched.status).toBe(200);
    await annotate("continue this with codex");

    const marker = await readMarker(createMarker, 10_000);
    const handoffSessionId = marker.sessionId as string;
    expect(marker.harness).toBe("codex");
    expect(handoffSessionId).not.toBe("sess-1");
    expect(marker.model).toBe("gpt-5.6-sol");
    expect(marker.effort).toBe("high");
    expect(marker.cwd).toBe(realpathSync(proj));
    const argv = marker.argv as string[];
    expect(argv.join("\n")).toContain(paths.logPath);
    expect(argv.join("\n")).toContain("full Lucid review record");
    const latestSession = await waitForLatestSession(
      (session) => session.harness === "codex" && session.sessionId === "codex-thread-from-output",
    );
    expect(latestSession).toMatchObject({
      harness: "codex",
      sessionId: "codex-thread-from-output",
    });

    // The announced thread must exist in the local Codex store before the
    // engine will resume it - pre-flight refuses a store-absent id.
    const codexStore = join(dir, "codex-switch-store");
    await mkdir(join(codexStore, "2026", "08", "01"), { recursive: true });
    await writeFile(
      join(
        codexStore,
        "2026",
        "08",
        "01",
        "rollout-2026-08-01T10-00-00-codex-thread-from-output.jsonl",
      ),
      "{}\n",
    );
    process.env.LUCID_CODEX_SESSIONS = codexStore;
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a2",
      version: 1,
      target: elementTarget,
      note: "a second turn on the exact codex thread",
    });
    const resumed = await readMarker(attendMarker, 10_000);
    expect(resumed.argv as string[]).toContain("codex-thread-from-output");
  }, 20_000);

  test("the poisoned record: a synthetic log stamp never reaches resume argv", async () => {
    // The EXACT reported failure. The log carries an old untyped stamp whose
    // sessionId is a Lucid-minted UUID codex never knew (cf4f...), while the
    // sidecar holds the real thread codex announced. Resume must name the
    // sidecar's thread and must never offer the synthetic one.
    const synthetic = "cf4f0000-1111-4222-8333-444455556666";
    artifact = join(proj, "poisoned.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "codex", sessionId: synthetic, cwd: paths.artifactDir },
    });
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: "0199-real-codex-thread",
      sessionIdAuthority: "observed",
      launchId: "abc123def4567890",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
    });
    // The real thread is in the local store (pre-flight); the synthetic one
    // never is, which is one more reason it cannot reach argv.
    const codexStore = join(dir, "codex-poisoned-store");
    await mkdir(join(codexStore, "2026", "08", "01"), { recursive: true });
    await writeFile(
      join(
        codexStore,
        "2026",
        "08",
        "01",
        "rollout-2026-08-01T10-00-00-0199-real-codex-thread.jsonl",
      ),
      "{}\n",
    );
    process.env.LUCID_CODEX_SESSIONS = codexStore;
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "codex" }));

    const hub = await startDaemon();
    await mount(hub);
    await annotate("resume the thread codex actually has");

    const resumed = await readMarker(attendMarker, 10_000);
    const argv = (resumed.argv as string[]).join(" ");
    expect(argv).toContain("0199-real-codex-thread");
    expect(argv).not.toContain(synthetic);
  }, 20_000);

  test("a not-found session is quarantined across restart, and one fallback is tried", async () => {
    // The harness says the thread does not exist here (HSI004). That is a
    // verdict: the id is quarantined durably, the transient ladder is
    // bypassed, and the ONE distinct fallback candidate is tried next.
    const notFound = join(dir, "codex-not-found");
    await writeFile(
      notFound,
      '#!/bin/sh\necho "Error: no rollout found for thread id" >&2\nexit 1\n',
    );
    await chmod(notFound, 0o755);
    artifact = join(proj, "gone.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "codex", sessionId: "dead-thread", cwd: paths.artifactDir },
    });
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: "dead-thread",
      sessionIdAuthority: "observed",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
    });
    // The local store HOLDS the thread, so pre-flight lets the spawn run and
    // the verdict comes from the harness's own mouth - the HSI004 path this
    // test exists to pin. (A store-absent id is refused before any process
    // runs, which is a different, batch-scoped mechanism.)
    const codexStore = join(dir, "codex-store");
    await mkdir(join(codexStore, "2026", "08", "01"), { recursive: true });
    await writeFile(
      join(codexStore, "2026", "08", "01", "rollout-2026-08-01T10-00-00-dead-thread.jsonl"),
      "{}\n",
    );
    process.env.LUCID_CODEX_SESSIONS = codexStore;
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "codex",
        harnesses: {
          codex: {
            sessionIdentity: {
              event: "thread.started",
              field: "thread_id",
              requiredArgument: "--json",
              source: "stdout-jsonl",
            },
            spawn: [notFound, "--json", "{artifact}", "{prompt}"],
            resume: [notFound, "--json", "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "codex" }));

    const hub = await startDaemon();
    await mount(hub);
    await annotate("this feedback must survive a dead thread");

    // The quarantine is DURABLE: it lands in the sidecar, so a restarted
    // engine does not ask the harness about the same dead id again.
    const deadline = Date.now() + 10_000;
    let invalidated: readonly string[] | undefined;
    while (Date.now() < deadline && invalidated === undefined) {
      invalidated = (await readLastAttendant(paths))?.invalidatedSessionIds;
      if (invalidated === undefined) await sleep(100);
    }
    expect(invalidated).toContain("dead-thread");
    // And the human's feedback is still theirs: nothing advanced past it.
    const state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.annotations.length).toBeGreaterThan(0);
  }, 20_000);

  test("after a not-found verdict the ONE weaker candidate is tried, then the engine stands down", async () => {
    // Two provable candidates, both dead. The first not-found retires it and
    // the fallback is tried; the second exhausts the ladder, and the human is
    // told rather than left watching silent retries forever.
    const notFound = join(dir, "codex-none");
    await writeFile(
      notFound,
      '#!/bin/sh\necho "Error: no rollout found for thread id" >&2\nexit 1\n',
    );
    await chmod(notFound, 0o755);
    artifact = join(proj, "exhausted.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "codex", sessionId: "thread-a", cwd: paths.artifactDir },
    });
    // Two candidates for ONE harness: the sidecar id (tier 1, the primary)
    // and a durable binding whose id this machine's Codex store corroborates
    // (tier 2, the single permitted fallback).
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: "thread-b",
      sessionIdAuthority: "observed",
      at: "2026-08-01T09:00:00.000Z",
    });
    const codexStore = join(dir, "codex-store");
    await mkdir(join(codexStore, "2026", "08", "01"), { recursive: true });
    await writeFile(
      join(codexStore, "2026", "08", "01", "rollout-2026-08-01T10-00-00-thread-a.jsonl"),
      "{}\n",
    );
    // thread-b too: BOTH candidates must pass pre-flight so both verdicts
    // come from the harness (HSI004) and the exhaustion path is reached.
    await writeFile(
      join(codexStore, "2026", "08", "01", "rollout-2026-08-01T11-00-00-thread-b.jsonl"),
      "{}\n",
    );
    process.env.LUCID_CODEX_SESSIONS = codexStore;
    await appendEvent(paths.logPath, {
      t: "harness_session_bound",
      id: "hsb:abc123def4567890:thread-a",
      launchId: "abc123def4567890",
      attendant: {
        harness: "codex",
        sessionId: "thread-a",
        sessionIdAuthority: "observed",
      },
    });
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "codex",
        harnesses: {
          codex: {
            sessionIdentity: {
              event: "thread.started",
              field: "thread_id",
              requiredArgument: "--json",
              source: "stdout-jsonl",
            },
            spawn: [notFound, "--json", "{artifact}", "{prompt}"],
            resume: [notFound, "--json", "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "codex" }));

    const hub = await startDaemon();
    await mount(hub);
    await annotate("both recorded threads are gone");

    // BOTH ids end up quarantined - the primary, then the one fallback.
    const deadline = Date.now() + 12_000;
    let dead: readonly string[] = [];
    while (Date.now() < deadline && dead.length < 2) {
      const sidecars = await readAttendantSidecars(paths);
      dead = sidecars.flatMap((a) => a.invalidatedSessionIds ?? []);
      if (dead.length < 2) await sleep(100);
    }
    expect([...dead].sort()).toEqual(["thread-a", "thread-b"]);
    // The feedback is still the human's: nothing consumed it.
    const state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.annotations.length).toBeGreaterThan(0);
  }, 20_000);

  test("identity warnings and the hub log carry no review content", async () => {
    // R1: a warning is a CODE plus Lucid's own sentence. Neither it nor the
    // retained hub log may carry the human's words, the harness's output, or
    // the artifact - the one place those live is the session's own record.
    const secret = "SECRET-ANNOTATION-TEXT-do-not-leak";
    const notFound = join(dir, "codex-leaky");
    await writeFile(
      notFound,
      `#!/bin/sh\necho "Error: no rollout found for thread id" >&2\necho "harness prose: HARNESS-OUTPUT-do-not-leak" >&2\nexit 1\n`,
    );
    await chmod(notFound, 0o755);
    artifact = join(proj, "redaction.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "codex", sessionId: "dead-one", cwd: paths.artifactDir },
    });
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: "dead-one",
      sessionIdAuthority: "observed",
      at: new Date().toISOString(),
    });
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "codex",
        harnesses: {
          codex: {
            sessionIdentity: {
              event: "thread.started",
              field: "thread_id",
              requiredArgument: "--json",
              source: "stdout-jsonl",
            },
            spawn: [notFound, "--json", "{artifact}", "{prompt}"],
            resume: [notFound, "--json", "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "codex" }));

    logs.length = 0;
    const hub = await startDaemon();
    await mount(hub);
    // Watch the session's own frames: warnings reach a human this way.
    const frames: string[] = [];
    const stream = await fetch(
      `http://127.0.0.1:${hub.port}/s/${sessionId(paths.artifactPath)}/__lucid/events`,
      { headers: { host: `127.0.0.1:${hub.port}` } },
    );
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      while (reader) {
        const { value, done } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        if (value) frames.push(decoder.decode(value, { stream: true }));
      }
    })();
    await annotate(secret);

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const sidecar = await readLastAttendant(paths);
      if ((sidecar?.invalidatedSessionIds ?? []).length > 0) break;
      await sleep(100);
    }
    await sleep(300);
    await reader?.cancel().catch(() => {});
    const seen = frames.join("");
    // The warning surface: Lucid's own sentence, never the harness's.
    expect(seen).not.toContain("HARNESS-OUTPUT-do-not-leak");
    // The retained hub log: it may NAME the file to read, never quote it.
    const hubLog = logs.join("\n");
    expect(hubLog).not.toContain(secret);
    expect(hubLog).not.toContain("HARNESS-OUTPUT-do-not-leak");
  }, 20_000);

  test("a moved artifact starts a fresh same-harness session in its new project", async () => {
    const oldProject = join(dir, "old-project");
    const lucidDir = join(proj, ".lucid");
    await mkdir(oldProject, { recursive: true });
    await mkdir(lucidDir, { recursive: true });
    artifact = join(lucidDir, "moved.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "codex", sessionId: "old-codex-thread", cwd: oldProject },
    });
    // A PROVABLE candidate, so the fresh handoff below is driven by the
    // project move - not by the artifact simply having no resumable session,
    // which would make this test pass for the wrong reason.
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: "old-codex-thread",
      sessionIdAuthority: "declared",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
    });
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "codex" }));

    const hub = await startDaemon();
    await mount(hub);
    await annotate("retry from the artifact's new project");

    const marker = await readMarker(createMarker, 2_000);
    expect(marker.cwd).toBe(realpathSync(proj));
    expect(marker.harness).toBe("codex");
    expect(marker.sessionId).not.toBe("old-codex-thread");
  }, 10_000);

  test("switching harness bypasses the usage-limited harness's cooldown", async () => {
    const limited = join(dir, "limited-claude");
    const codex = join(dir, "codex-create");
    await writeFile(
      limited,
      '#!/bin/sh\necho "You\'ve hit your weekly limit - resets 2am" >&2\nexit 1\n',
    );
    await chmod(limited, 0o755);
    await writeExecStub(codex, createMarker);
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "claude-code",
        harnesses: {
          "claude-code": {
            spawn: [limited, "{prompt}"],
            resume: [limited, "{prompt}"],
          },
          codex: {
            // A declared identity strategy, because the harness switch below
            // is a HANDOFF: a recipe that declares none would have Lucid mint
            // an id nothing can resume, and unattended launch refuses that
            // (HSI001) before any process exists.
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [codex, "--sid", "{id}", "{artifact}", "{prompt}"],
            resume: [codex, "--sid", "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );

    const hub = await startDaemon();
    await mount(hub);
    await annotate("continue despite the old harness limit");
    const limitedBy = Date.now() + 10_000;
    let hitLimit = false;
    while (Date.now() < limitedBy && !hitLimit) {
      hitLimit = (await readEvents(paths.logPath)).events.some(
        (event) => event.t === "agent_turn_ended" && event.reason === "usage_limit",
      );
      if (!hitLimit) await sleep(50);
    }
    expect(hitLimit).toBe(true);

    const switched = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ harness: "codex" }),
    });
    expect(switched.status).toBe(200);
    const marker = await readMarker(createMarker, 10_000);
    expect(marker.harness).toBe("codex");
  }, 20_000);

  test("switching harness bypasses a generic delivery-failure cooldown", async () => {
    const failed = join(dir, "failed-claude");
    const codex = join(dir, "codex-create");
    await writeFile(failed, '#!/bin/sh\necho "transport broke" >&2\nexit 1\n');
    await chmod(failed, 0o755);
    await writeExecStub(codex, createMarker);
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "claude-code",
        harnesses: {
          "claude-code": {
            spawn: [failed, "{prompt}"],
            resume: [failed, "{prompt}"],
          },
          codex: {
            // A declared identity strategy, because the harness switch below
            // is a HANDOFF: a recipe that declares none would have Lucid mint
            // an id nothing can resume, and unattended launch refuses that
            // (HSI001) before any process exists.
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [codex, "--sid", "{id}", "{artifact}", "{prompt}"],
            resume: [codex, "--sid", "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );

    const hub = await startDaemon();
    await mount(hub);
    await annotate("continue after the source harness fails");
    const failedBy = Date.now() + 10_000;
    let failures = 0;
    while (Date.now() < failedBy && failures < 3) {
      failures = (await readEvents(paths.logPath)).events.filter(
        (event) => event.t === "agent_turn_ended" && event.reason === "failed",
      ).length;
      if (failures < 3) await sleep(50);
    }
    expect(failures).toBe(3);

    const switched = await req(hub.port, selectionUrl(), {
      method: "POST",
      body: JSON.stringify({ harness: "codex" }),
    });
    expect(switched.status).toBe(200);
    const marker = await readMarker(createMarker, 2_000);
    expect(marker.harness).toBe("codex");
  }, 15_000);
});

/**
 * Nearly every artifact ever rendered lives in an agent scratchpad while the
 * conversation that wrote it ran in the project checkout. "Has this artifact
 * moved projects?" therefore has to DECODE the scratchpad path before it
 * compares - the one question `projectOf` answers.
 *
 * Comparing the raw folder walk instead made every such artifact look moved,
 * and a moved artifact gets a fresh handoff: the human's feedback reached a
 * stranger with no memory of the review, while the hub's own listing grouped
 * that same artifact under the decoded checkout.
 */
describe("a scratchpad artifact resumes in the project its path encodes", () => {
  let dir: string;
  let repo: string;
  let harnessesPath: string;
  let resumeMarker: string;
  let spawnMarker: string;
  let switchMarker: string;
  const logs: string[] = [];

  /** Flatten a real path the way Claude Code does (`/` and `.` both become
   *  `-`), so the fixture states the input the way it actually arrives. */
  const flatten = (path: string): string => path.replaceAll("/", "-").replaceAll(".", "-");

  /**
   * A review in the scratchpad of an agent working in `agentCwd`, with that
   * same cwd on the record.
   *
   * The agent's cwd is the PARAMETER because it is as often a package inside
   * the checkout as the checkout root itself, and the two spellings took
   * different paths through the engine: comparing a normalized prior cwd
   * against a raw one made every agent working below its own repo root look
   * like it had moved projects.
   */
  const reviewFrom = async (agentCwd: string): Promise<SessionPaths> => {
    const scratchpad = join(
      dir,
      "claude-501",
      flatten(agentCwd),
      "40c9c345-b638-4286-bfce-796d9e6fad98",
      "scratchpad",
    );
    await mkdir(scratchpad, { recursive: true });
    const artifact = join(scratchpad, "plan.html");
    await writeFile(artifact, DOC);
    const paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "stub", sessionId: "sess-1", cwd: agentCwd },
    });
    await mergeAttendantSidecar(paths, {
      harness: "stub",
      sessionId: "sess-1",
      sessionIdAuthority: "declared",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
    });
    return paths;
  };

  /** Drive the engine until one of the three stubs has run, or give up. */
  const settle = async (paths: SessionPaths): Promise<void> => {
    const attendant = createAttendant({
      paths,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      log: (m) => logs.push(m),
    });
    try {
      const ran = async (): Promise<boolean> =>
        (await Bun.file(resumeMarker).exists()) ||
        (await Bun.file(spawnMarker).exists()) ||
        (await Bun.file(switchMarker).exists());
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !(await ran())) {
        await attendant.tick();
        await sleep(60);
      }
    } finally {
      attendant.stop();
    }
  };

  beforeEach(async () => {
    logs.length = 0;
    dir = realpathSync(await mkdtemp(join(tmpdir(), "lucid-attend-scratch-")));
    repo = join(dir, "dev", "proj");
    await mkdir(join(repo, ".git"), { recursive: true });
    resetPresenceCache();
    resetSessionCwdCache();

    harnessesPath = join(dir, "harnesses.json");
    resumeMarker = join(dir, "resume-marker.json");
    spawnMarker = join(dir, "spawn-marker.json");
    switchMarker = join(dir, "switch-marker.json");
    const resumeStub = join(dir, "stub-resume.ts");
    const spawnStub = join(dir, "stub-spawn.ts");
    const switchStub = join(dir, "stub-switch.ts");
    await writeStub(resumeStub, resumeMarker);
    await writeStub(spawnStub, spawnMarker);
    await writeStub(switchStub, switchMarker);
    // One stub per recipe: which marker appears IS the verdict - resume, fresh
    // handoff to the same harness, or handoff to the one the human picked -
    // with no need to read the engine's own narration.
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "stub",
        harnesses: {
          stub: {
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [process.execPath, "run", spawnStub, "--sid", "{id}", "{artifact}", "{prompt}"],
            resume: [
              process.execPath,
              "run",
              resumeStub,
              "--sid",
              "{id}",
              "{artifact}",
              "{prompt}",
            ],
          },
          other: {
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [process.execPath, "run", switchStub, "--sid", "{id}", "{artifact}", "{prompt}"],
          },
        },
      }),
    );
  });

  afterEach(async () => {
    applyUnitEnv();
    resetPresenceCache();
    resetSessionCwdCache();
    await rm(dir, { recursive: true, force: true });
  });

  test("delivers by resuming the recorded session, not by handing off to a stranger", async () => {
    // The harness ran in the CHECKOUT - which is exactly what its scratchpad
    // path encodes.
    const paths = await reviewFrom(repo);
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-scratchpad",
      version: 1,
      target: elementTarget,
      note: "this belongs to the session that wrote the artifact",
    });

    await settle(paths);

    const marker = await readMarker(resumeMarker);
    expect(marker.sessionId).toBe("sess-1");
    // The established session's own directory (D10), which the scratchpad
    // path names and the scratchpad itself is not.
    expect(marker.cwd).toBe(repo);
    expect(await Bun.file(spawnMarker).exists()).toBe(false);
  }, 40_000);

  test("an agent working inside its checkout has not moved projects", async () => {
    // The common shape: the conversation ran in one package of a repo, so its
    // cwd is BELOW the checkout root. Both sides of "did this move?" have to
    // be normalized the same way, or the package dir never equals the root it
    // sits in and every one of these reviews gets handed to a stranger.
    const pkg = join(repo, "packages", "app");
    await mkdir(pkg, { recursive: true });
    const paths = await reviewFrom(pkg);
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-package",
      version: 1,
      target: elementTarget,
      note: "written from a package inside the repo",
    });

    await settle(paths);

    const marker = await readMarker(resumeMarker);
    expect(marker.sessionId).toBe("sess-1");
    expect(marker.cwd).toBe(pkg);
    expect(await Bun.file(spawnMarker).exists()).toBe(false);
  }, 40_000);

  test("a decoded checkout that is gone never becomes the turn's cwd", async () => {
    // The decode names the WORK even when the directory is gone (an ephemeral
    // worktree is deleted once its work lands, and the review outlives it) -
    // right for a listing heading, fatal as a cwd. Same fixture, with the
    // encoded checkout removed from under it.
    const paths = await reviewFrom(repo);
    await rm(repo, { recursive: true, force: true });
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-gone",
      version: 1,
      target: elementTarget,
      note: "the checkout this was written in no longer exists",
    });

    await settle(paths);

    const marker = await readMarker(resumeMarker);
    expect(marker.cwd).toBe(paths.artifactDir);
  }, 40_000);

  test("a fresh harness starts where it can still write the artifact", async () => {
    // A harness switch is a handoff whatever the projects say, and a handoff
    // is the one turn that does not inherit a cwd. It gets the checkout the
    // artifact SITS in - here the scratchpad - because a sandboxed harness can
    // only write below its own cwd, and the decoded project it BELONGS to is a
    // directory the artifact is not in.
    const paths = await reviewFrom(repo);
    await writeFile(paths.selectionPath, JSON.stringify({ harness: "other" }));
    await appendEvent(paths.logPath, {
      t: "annotation",
      id: "a-switch",
      version: 1,
      target: elementTarget,
      note: "attend this with the harness I picked",
    });

    await settle(paths);

    const marker = await readMarker(switchMarker);
    expect(marker.harness).toBe("other");
    expect(marker.cwd).toBe(paths.artifactDir);
    expect(await Bun.file(resumeMarker).exists()).toBe(false);
  }, 40_000);
});
