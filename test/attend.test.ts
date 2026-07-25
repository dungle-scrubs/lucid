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
    expect(await Bun.file(join(paths.sessionDir, "selection.json")).json()).toEqual({
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
    expect(await Bun.file(join(paths.sessionDir, "selection.json")).json()).toEqual({
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
    expect(await Bun.file(join(paths.sessionDir, "selection.json")).exists()).toBe(false);
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
      join(paths.sessionDir, "selection.json"),
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
    const child = sessionPaths(join(proj, "new-plan.html"));
    expect(await Bun.file(join(child.sessionDir, "selection.json")).json()).toEqual({
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
