import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../src/core/events.ts";
import { appendEvent, readEvents } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { openSession } from "../src/core/session.ts";
import { attendDecision, pendingHumanSeqs } from "../src/server/attend.ts";
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
const readMarker = async (path: string, timeoutMs = 10_000): Promise<Record<string, unknown>> => {
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
    await rm(dir, { recursive: true, force: true });
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
    const res = await post(hub.port, "/hub/create", {
      project: proj,
      name: "plan.html",
      prompt: "map the migration",
    });
    expect(res.status).toBe(409);
  });

  test("POST /hub/create refuses to write through a dangling symlink", async () => {
    const hub = await startDaemon(true);
    // stat() reports a dangling link as absent; creating "into" it would put
    // the artifact wherever the link points, outside the approved project.
    await symlink(join(dir, "elsewhere", "gone.html"), join(proj, "linked.html"));
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
    expect(body.artifact).toBe(join(proj, "new-plan.html"));

    const marker = await readMarker(createMarker);
    expect(marker.harness).toBe("stub");
    expect(marker.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(marker.cwd).toBe(realpathSync(proj));
    const argv = marker.argv as string[];
    expect(argv[1]).toBe(join(proj, "new-plan.html"));
    expect(argv[2]).toContain("map the migration");
    expect(argv[2]).toContain(`lucid open ${join(proj, "new-plan.html")}`);
  }, 20_000);
});
