import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations } from "../../src/cli/conversations.js";
import { startHeadless } from "../../src/cli/runtime.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import type { createHeadlessHost } from "../../src/modes/host.js";
import type { Frame } from "../../src/protocol/index.js";
import type { acquirePresence, PresenceHandle } from "../../src/store/presence.js";
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
  inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "fake" }),
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
