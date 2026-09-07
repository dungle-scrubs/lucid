import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations } from "../../src/cli/record-addressing.js";
import { openDrivenConversation, startHeadless } from "../../src/cli/runtime.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { HCN_MIN_VERSION } from "../../src/harness/version.js";
import type { createHeadlessHost } from "../../src/modes/host.js";
import { readProcessOwner } from "../../src/process-owner.js";
import type { Frame } from "../../src/protocol/index.js";
import { createConversationHost, openWriter } from "../../src/store/conversation-host.js";
import { StoreError } from "../../src/store/errors.js";
import type { acquirePresence, PresenceHandle } from "../../src/store/presence.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";
import { attach, event } from "../protocol/helpers.js";

/** The runtime never opens a session or streams a turn in these tests: the
 * fake source replaces the whole headless host, so the runner answers the
 * one question `startHeadless` asks (session support) and nothing else. */
const fakeRunner: HarnessRunner = {
  openSession: () => {
    throw new Error("not used by this test");
  },
  streamTurn: () => {
    throw new Error("not used by this test");
  },
  inspect: async () => ({
    name: "claude",
    session: true,
    verifiedAgainst: "fake",
    runtime: {
      executable: { path: "/fake/claude", version: "fake" },
      resume: { status: "supported", reason: null },
    },
  }),
  countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
  capabilities: async () => ({
    vision: false,
    images: false,
    streaming: "line",
    session: true,
    source: "curated",
    confidence: "high",
  }),
};

/** A presence handle the test flips by hand - what `acquirePresenceFn`
 * hands the runtime, with `held()` answering the same local boolean the
 * real handle does. */
const fakePresence = (): { handle: PresenceHandle; acquire: typeof acquirePresence } => {
  let held = false;
  const handle: PresenceHandle = {
    release: (): void => {
      held = false;
    },
    held: () => held,
  };
  const acquire: typeof acquirePresence = () => {
    held = true;
    return handle;
  };
  return { handle, acquire };
};

test("legacy runtime does not drain managed inputs armed during lease expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-runtime-managed-fence-"));
  const { dir } = conversations(root).ensure("managed-fence");
  const writer = openWriter(dir);
  writer.acceptInput(
    { id: "managed", text: "do not dispatch to old source", mode: "queue" },
    { managed: true },
  );
  writer.close();
  const seen: Frame[] = [];
  const running = await openDrivenConversation({
    rootDir: root,
    conversationId: "managed-fence",
    runner: fakeRunner,
    acquirePresenceFn: fakePresence().acquire,
    presence: () => false,
    pollMs: 1,
    createHeadlessHostFn: () => ({
      receive: (frame) => {
        seen.push(frame);
      },
      close: () => {},
    }),
  });
  if (running.kind !== "running") throw new Error("expected runtime");
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(seen.filter((frame) => frame.kind === "input")).toHaveLength(0);
  } finally {
    running.abort();
    await running.done;
  }
});

test.each([false, true])(
  "a detached living owner prevents takeover, with identity: %s",
  async (identity) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-runtime-owner-"));
    const { dir, secret } = conversations(root).ensure("living-owner");
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("test process identity unavailable");
    const writer = openWriter(dir, { now: () => 1 });
    writer.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "living-owner",
        secret,
        version: 1,
        profile: "interactive",
        harness: "claude",
        owner,
      }),
    );
    if (identity)
      writer.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "interactive-owner",
          event: { kind: "identity", sessionId: "native-live", authority: "harness-minted" },
        }),
      );
    writer.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "yield" }));
    writer.close();
    const result = await openDrivenConversation({
      rootDir: root,
      conversationId: "living-owner",
      runner: fakeRunner,
      acquirePresenceFn: () => {
        throw new Error("must not acquire while the terminal owner lives");
      },
    });
    expect(result.kind).toBe("await-reattach");
  },
);

test("a departed terminal continues its native session in the saved folder with a mode notice", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-runtime-departed-"));
  const folder = join(root, "nested");
  mkdirSync(folder);
  const { dir, secret } = conversations(root).ensure("departed", {
    workingDirectory: folder,
    preference: {
      v: 1,
      harness: "claude",
      model: "concrete-opus",
      effort: "high",
      profile: "interactive",
      revision: 1,
    },
  });
  const terminal = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const owner = readProcessOwner(terminal.pid);
    if (!owner) throw new Error("terminal process identity unavailable");
    const writer = openWriter(dir, { now: () => 1 });
    expect(
      writer.handleFrame(
        JSON.stringify({
          kind: "attach",
          conversationId: "departed",
          secret,
          version: 1,
          profile: "interactive",
          harness: "claude",
          owner,
        }),
      ).verdict,
    ).toBe("accepted");
    writer.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "terminal-id",
        event: { kind: "identity", sessionId: "native-terminal", authority: "harness-minted" },
      }),
    );
    writer.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "yield" }));
    writer.enqueueInput({ id: "continue", text: "continue the work", mode: "queue" });
    writer.close();
    terminal.kill();
    await terminal.exited;
    const proc = new FakeHcnProcess();
    const spawner = fakeSpawner([proc]);
    const runner = {
      ...createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
      inspect: fakeRunner.inspect,
    };
    const running = await openDrivenConversation({
      rootDir: root,
      conversationId: "departed",
      runner,
      acquirePresenceFn: fakePresence().acquire,
    });
    if (running.kind !== "running") throw new Error("expected continuation");
    try {
      await Bun.sleep(0);
      expect(running.profile).toBe("headless-turn");
      expect(spawner.calls[0]?.argv).toContain("native-terminal");
      expect(spawner.calls[0]?.opts.cwd).toBe(realpathSync(folder));
      const log = readFileSync(join(dir, "log.ndjson"), "utf8");
      expect(log).toContain("terminal process has exited");
      expect(log).toContain("headless-turn");
      expect(running.host.state().lastParticipation?.owner?.pid).toBe(process.pid);
      expect(JSON.parse(readFileSync(join(dir, "driver.json"), "utf8"))).toMatchObject({
        profile: "interactive",
        revision: 1,
      });
      proc.emit({ kind: "identity", sessionId: "native-terminal", authority: "harness-minted" });
      proc.emit({ kind: "done", cause: "clean", exitCode: 0 });
      proc.exit(0);
      await Bun.sleep(0);
    } finally {
      running.abort();
      proc.exit(0);
    }
    const next = new FakeHcnProcess();
    const nextSpawner = fakeSpawner([next]);
    const writerAgain = openWriter(dir);
    writerAgain.enqueueInput({ id: "again", text: "continue again", mode: "queue" });
    writerAgain.close();
    const restarted = await openDrivenConversation({
      rootDir: root,
      conversationId: "departed",
      runner: {
        ...createHcnRunner({ spawn: nextSpawner.spawn, bin: "/fake/hcn" }),
        inspect: fakeRunner.inspect,
      },
      acquirePresenceFn: fakePresence().acquire,
    });
    if (restarted.kind !== "running") throw new Error("expected continuation after restart");
    try {
      await Bun.sleep(0);
      expect(nextSpawner.calls[0]?.argv).toContain("native-terminal");
      expect(
        readFileSync(join(dir, "log.ndjson"), "utf8").match(/terminal process has exited/g),
      ).toHaveLength(1);
    } finally {
      restarted.abort();
      next.exit(0);
    }
  } finally {
    terminal.kill();
    await terminal.exited;
  }
});

test("a terminal attaching during executor acquisition prevents the pending headless launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-runtime-owner-race-"));
  const { dir, secret } = conversations(root).ensure("race");
  const presence = fakePresence();
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("test owner unavailable");
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const runner = {
    ...createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
    inspect: fakeRunner.inspect,
  };
  try {
    await expect(
      openDrivenConversation({
        rootDir: root,
        conversationId: "race",
        runner,
        acquirePresenceFn: (...args) => {
          const handle = presence.acquire(...args);
          const writer = openWriter(dir, { now: () => 1 });
          writer.handleFrame(
            JSON.stringify({
              kind: "attach",
              conversationId: "race",
              secret,
              version: 1,
              profile: "interactive",
              harness: "claude",
              owner,
            }),
          );
          writer.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "yield" }));
          writer.close();
          return handle;
        },
      }),
    ).rejects.toMatchObject({ code: "E-HUB-03" });
    expect(spawner.calls).toHaveLength(0);
    expect(presence.handle.held()).toBe(false);
  } finally {
    proc.exit(0);
  }
});

test.each(["headless-turn", "interactive"] as const)(
  "unknown compatibility preserves the prompt and %s selection",
  async (profile) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-runtime-unknown-adapter-"));
    const { dir, secret } = conversations(root).ensure("unknown", {
      workingDirectory: root,
      preference: {
        v: 1,
        harness: "claude",
        model: "concrete-opus",
        effort: "high",
        profile,
        revision: 1,
      },
    });
    const writer = openWriter(dir, { now: () => 1 });
    writer.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "unknown",
        secret,
        version: 1,
        profile,
        harness: "claude",
      }),
    );
    writer.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "prior",
        event: { kind: "identity", sessionId: "native-prior", authority: "harness-minted" },
      }),
    );
    writer.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "yield" }));
    writer.enqueueInput({ id: "held", text: "continue", mode: "queue" });
    writer.close();
    const proc = new FakeHcnProcess();
    const spawner = fakeSpawner([proc]);
    const runner = {
      ...createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
      inspect: async () => ({
        name: "claude",
        session: true,
        verifiedAgainst: "old",
        runtime: {
          executable: { path: "/selected/claude", version: "new" },
          resume: { status: "unknown" as const, reason: "Version not verified" },
        },
      }),
    };
    const presence = fakePresence();
    let result: Awaited<ReturnType<typeof openDrivenConversation>> | undefined;
    try {
      await expect(
        openDrivenConversation({
          rootDir: root,
          conversationId: "unknown",
          runner,
          presence: () => false,
          acquirePresenceFn: presence.acquire,
        }).then((running) => {
          result = running;
          return running;
        }),
      ).rejects.toMatchObject({ code: "E-HUB-03" });
      expect(spawner.calls).toHaveLength(0);
      expect(presence.handle.held()).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, "driver.json"), "utf8")).profile).toBe(profile);
      const reopened = openWriter(dir);
      try {
        expect(reopened.state().inputs).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "held", text: "continue" })]),
        );
        expect(reopened.state().epoch).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      if (result?.kind === "running") result.abort();
      proc.exit(0);
    }
  },
);

test("a legacy conversation with no saved folder refuses launch and keeps its prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-runtime-no-cwd-"));
  const { paths } = createConversationRecord(root, "legacy");
  const writer = openWriter(paths.dir);
  writer.enqueueInput({ id: "pending", text: "continue here", mode: "queue" });
  writer.close();
  const presence = fakePresence();
  const source = makeFakeSource();
  await expect(
    openDrivenConversation({
      rootDir: root,
      conversationId: "legacy",
      runner: fakeRunner,
      acquirePresenceFn: presence.acquire,
      createHeadlessHostFn: source.factory,
    }),
  ).rejects.toMatchObject({ code: "E-HUB-04" });
  expect(presence.handle.held()).toBe(false);
  const reopened = openWriter(paths.dir);
  try {
    expect(reopened.state().inputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "pending", text: "continue here" })]),
    );
    expect(reopened.state().epoch).toBe(0);
  } finally {
    reopened.close();
  }
});

test.each(["verified", "different"])(
  "an unverified later identity %s cannot authorize native resume",
  async (latestId) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-unverified-latest-"));
    const { dir, secret } = conversations(root).ensure("unknown-id", {
      workingDirectory: root,
      preference: { v: 1, revision: 1, harness: "claude", profile: "headless-turn" },
    });
    const writer = openWriter(dir, { now: () => 1 });
    try {
      writer.handleFrame(
        JSON.stringify({
          kind: "attach",
          conversationId: "unknown-id",
          secret,
          version: 1,
          profile: "headless-turn",
          harness: "claude",
        }),
      );
      for (const [index, identity] of [
        { sessionId: "verified", authority: "harness-minted" },
        { sessionId: latestId, authority: "future-authority" },
      ].entries())
        writer.handleFrame(
          JSON.stringify({
            kind: "event",
            epoch: 1,
            n: index + 1,
            turnId: "prior",
            event: { kind: "identity", ...identity },
          }),
        );
      writer.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "yield" }));
      writer.enqueueInput({ id: "pending", mode: "queue", text: "continue" });
    } finally {
      writer.close();
    }
    let running: Awaited<ReturnType<typeof openDrivenConversation>> | undefined;
    try {
      await expect(
        openDrivenConversation({
          rootDir: root,
          conversationId: "unknown-id",
          runner: fakeRunner,
          acquirePresenceFn: fakePresence().acquire,
        }).then((result) => {
          running = result;
          return result;
        }),
      ).rejects.toMatchObject({ code: "E-HUB-03" });
    } finally {
      if (running?.kind === "running") running.abort();
    }
  },
);

test("both headless profiles launch in the saved working folder rather than the caller folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-runtime-cwd-"));
  const folder = join(root, "project", "nested");
  mkdirSync(folder, { recursive: true });
  for (const profile of ["headless-turn", "headless-session"] as const) {
    conversations(root).ensure(profile, {
      workingDirectory: folder,
      preference: {
        v: 1,
        harness: "claude",
        model: "concrete-opus",
        effort: "high",
        profile,
        revision: 1,
      },
    });
    const proc = new FakeHcnProcess();
    const spawner = fakeSpawner([proc]);
    const runner = {
      ...createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
      inspect: fakeRunner.inspect,
    };
    const running = await openDrivenConversation({
      rootDir: root,
      conversationId: profile,
      runner,
      acquirePresenceFn: fakePresence().acquire,
    });
    if (running.kind !== "running") throw new Error("expected a running conversation");
    try {
      if (profile === "headless-session")
        proc.emit({
          kind: "session",
          sessionId: "native-cwd",
          harness: "claude",
          hcn: HCN_MIN_VERSION,
        });
      running.host.enqueueInput({ id: "cwd-input", text: "work here", mode: "queue" });
      await Bun.sleep(0);
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.opts.cwd).toBe(realpathSync(folder));
    } finally {
      proc.exit(0);
      running.abort();
    }
  }
});

/** Replaces the headless host: captures the `sendFrame` the runtime binds
 * to its real conversation host, and records every frame the host
 * dispatches to the source - which is exactly what the R2 gate controls. */
const makeFakeSource = (): {
  readonly received: Frame[];
  readonly factory: typeof createHeadlessHost;
  readonly send: (frame: Frame) => { verdict: string };
} => {
  const received: Frame[] = [];
  let sendFrame: ((frame: Frame) => { verdict: string }) | undefined;
  const factory = ((deps: { sendFrame: (frame: Frame) => { verdict: string } }) => {
    sendFrame = deps.sendFrame;
    return {
      receive: (f: Frame): void => {
        received.push(f);
      },
      close: (): void => {},
    };
  }) as unknown as typeof createHeadlessHost;
  const send = (frame: Frame): { verdict: string } => {
    if (sendFrame === undefined) throw new Error("source was never constructed");
    return sendFrame(frame);
  };
  return { received, factory, send };
};

describe("RFC-04 R2 at the runtime seam", () => {
  test("the dispatch gate reads the presence handle the runtime holds - not the interactive-process probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-runtime-"));
    const { secret } = conversations(root).ensure("conv-1");
    const presence = fakePresence();
    const source = makeFakeSource();
    const probe = { value: undefined as boolean | undefined };

    // Probe starts unknown: a fresh record reads agent-gone, so the D-021
    // gate lets the runtime acquire rather than await-reattach.
    const running = await startHeadless({
      rootDir: root,
      conversationId: "conv-1",
      harnessName: "claude",
      runner: fakeRunner,
      acquirePresenceFn: presence.acquire,
      createHeadlessHostFn: source.factory,
      presence: () => probe.value,
      now: () => 1_000,
      randomUUID: () => "session-fixed",
    });
    expect(running.kind).toBe("running");
    if (running.kind !== "running") return;

    // Holding the lease: writes through the runtime's host dispatch their
    // effects to the source, exactly as before the gate existed.
    const attachResult = source.send(attach({ secret, profile: "headless-session" }));
    expect(attachResult.verdict).toBe("accepted");
    expect(source.received.map((f) => f.kind)).toEqual(["attach-ok"]);
    source.send(event({ n: 1 }));
    expect(source.received.map((f) => f.kind)).toEqual(["attach-ok", "event-ack"]);

    // The lease is lost. Flip the interactive-process probe to alive: if
    // the gate read `HostDeps.presence` it would keep dispatching. It
    // reads the handle, so the next write still lands durably but none of
    // its effects are acted on.
    presence.handle.release();
    probe.value = true;
    const afterLoss = source.send(event({ n: 2 }));
    expect(afterLoss.verdict).toBe("accepted");
    expect(source.received.map((f) => f.kind)).toEqual(["attach-ok", "event-ack"]);
    const log = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    expect(log).toContain('"n":2');

    running.abort();
  });
});

describe("RFC-12: the startup honor fold at the runtime seam", () => {
  /** A factory that records the deps each spawn was built with, so the
   * harness and model a preference chose are asserted on what the runtime
   * actually spawned, not on what it reports. */
  const recordingFactory = (): {
    readonly factory: typeof createHeadlessHost;
    readonly spawns: { harness: unknown; model?: unknown }[];
  } => {
    const spawns: { harness: unknown; model?: unknown }[] = [];
    const factory = ((deps: { harness: unknown; model?: unknown }) => {
      spawns.push({ harness: deps.harness, model: deps.model });
      return {
        receive: (_f: Frame): void => {},
        close: (): void => {},
      };
    }) as unknown as typeof createHeadlessHost;
    return { factory, spawns };
  };

  const writePreference = (root: string, body: Record<string, unknown>): void => {
    const dir = join(root, "conv-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "driver.json"), JSON.stringify(body));
  };

  test("a preference in the record names the harness and model of the first spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-runtime-pref-"));
    conversations(root).ensure("conv-1");
    writePreference(root, { v: 1, harness: "codex", model: "gpt-6" });
    const presence = fakePresence();
    const source = recordingFactory();

    const running = await startHeadless({
      rootDir: root,
      conversationId: "conv-1",
      runner: fakeRunner,
      acquirePresenceFn: presence.acquire,
      createHeadlessHostFn: source.factory,
      now: () => 1_000,
    });
    expect(running.kind).toBe("running");
    if (running.kind !== "running") return;

    // No flag named a harness, so the preference's choice is the spawn.
    expect(source.spawns[0]?.harness).toBe("codex");
    expect(source.spawns[0]?.model).toBe("gpt-6");
    running.abort();
  });

  test("an explicit harness at spawn pins the harness for the process's life", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-runtime-pin-"));
    conversations(root).ensure("conv-1");
    writePreference(root, { v: 1, harness: "pi" });
    const presence = fakePresence();
    const source = recordingFactory();

    const running = await startHeadless({
      rootDir: root,
      conversationId: "conv-1",
      harnessName: "claude",
      runner: fakeRunner,
      acquirePresenceFn: presence.acquire,
      createHeadlessHostFn: source.factory,
      now: () => 1_000,
    });
    expect(running.kind).toBe("running");
    if (running.kind !== "running") return;

    // The flag wins on the harness dimension; the preference is not
    // consulted for it (RFC-12's resolution order).
    expect(source.spawns[0]?.harness).toBe("claude");
    running.abort();
  });
});

test("failed-log shutdown releases presence and closes the host while harness close is pending and diagnostics throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-failed-log-"));
  const { dir } = conversations(root).ensure("failed-log");
  const writer = openWriter(dir);
  writer.writeArtifact({
    artifactId: "doc",
    version: 1,
    author: "human",
    contentType: "text/html",
    bytes: "private test document",
  });
  writer.close();
  const proc = new FakeHcnProcess();
  const hcn = createHcnRunner({ spawn: fakeSpawner([proc]).spawn, bin: "/fake/hcn" });
  const diagnostics: string[] = [];
  let released = 0;
  let closed = 0;
  let held = true;
  const handle = await openDrivenConversation({
    rootDir: root,
    conversationId: "failed-log",
    runner: { ...fakeRunner, openSession: hcn.openSession },
    acquirePresenceFn: () => ({
      held: () => held,
      release: () => {
        held = false;
        released += 1;
      },
    }),
    openConversationFn: (path, deps) => {
      const host = createConversationHost(path, deps);
      return {
        ...host,
        readArtifact: () => {
          throw new StoreError("corrupt-log", "synthetic failure");
        },
        close: () => {
          closed += 1;
          host.close();
        },
      };
    },
    diagnostic: (line) => {
      diagnostics.push(line);
      throw new Error("sink failed");
    },
  });
  if (handle.kind !== "running") throw new Error("did not start");
  const cursor = handle.host.cursor();
  proc.emit({ kind: "session", sessionId: "session-1", harness: "claude", hcn: HCN_MIN_VERSION });
  handle.source.receive({
    kind: "input",
    id: "in-1",
    text: "sensitive input",
    mode: "queue",
    seq: 1,
  });
  await handle.done;
  await new Promise((r) => setTimeout(r, 0));
  expect(released).toBe(1);
  expect(closed).toBe(1);
  expect(handle.presenceHeld()).toBe(false);
  expect(handle.host.cursor()).toBe(cursor);
  expect(proc.commands.filter((c) => c.op === "send")).toEqual([]);
  expect(proc.commands.filter((c) => c.op === "close")).toHaveLength(1);
  expect(diagnostics).toEqual([
    `${JSON.stringify({
      code: "record-unreadable",
      conversationId: "failed-log",
      operation: "artifact-state",
      artifactId: "doc",
    })}\n`,
  ]);
  handle.abort();
  expect(released).toBe(1);
  proc.exit(0);
});
