import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createManagedExecution } from "../../src/modes/managed-execution.js";
import { createManagedPreparation } from "../../src/modes/managed-preparation.js";
import type { NativeBinding } from "../../src/protocol/connection.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-native-managed-")));
  const record = createConversationRecord(root, "native", { workingDirectory: root });
  const binding: NativeBinding = {
    generation: randomUUID(),
    harness: "codex",
    interface: "codex-cli",
    nativeSessionId: "native-session",
    registrationId: randomUUID(),
    workingDirectory: root,
    owner: { pid: 123, executable: "/synthetic/native", startedAt: "123:456" },
  };
  let ownerAlive = true;
  const host = createConversationHost(record.paths.dir, {
    connectionAuthority: () => binding,
    executorLease: () => true,
    nativeSessionRoot: root,
    now: () => 1,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: () => ownerAlive,
    presence: () => false,
  });
  const driver = {
    harness: "codex",
    model: "browser-model",
    effort: "low",
    profile: "headless-turn",
  } as const;
  replaceSettings(record.paths.dir, "native", 0, driver);
  expect(host.writeConnection({ actionId: randomUUID(), binding, kind: "bound" }).verdict).toBe(
    "accepted",
  );
  expect(
    host.acceptInput(
      { id: "feedback", mode: "queue", text: "Use the same native session" },
      { managed: true },
    ).verdict,
  ).toBe("accepted");
  ownerAlive = false;
  const runner: HarnessRunner = {
    inspectNativeContinuation: async (target) => {
      expect(target).toMatchObject({
        cwd: root,
        harness: "codex",
        resume: binding.nativeSessionId,
      });
      return {
        status: "available",
        model: "native-model",
        effort: "high",
        provider: "native-provider",
        fingerprint: "a".repeat(64),
      };
    },
    inspect: async (_harness, choice) => {
      expect(choice).toBeUndefined();
      return { name: "codex", session: false, nativeContextManagement: true };
    },
    capabilities: async () => {
      throw new Error("No model selection during native continuation");
    },
    countContext: async () => {
      throw new Error("The native harness manages its context");
    },
    openSession: async () => {
      throw new Error("Preparation starts no native process");
    },
    streamTurn: () => {
      throw new Error("Preparation starts no native process");
    },
  };
  return {
    root,
    binding,
    host,
    driver,
    runner,
    close: () => {
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("bound preparation records the native settings and one launch notice while keeping browser preferences separate", async () => {
  const f = setup();
  const { root, driver, host, runner, binding } = f;
  const preparation = createManagedPreparation({ cwd: root, driver, host, runner });
  try {
    const prepared = await preparation.prepare({
      inputId: "feedback",
      text: "Use the same native session",
      turnId: "turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    expect(prepared).toMatchObject({
      kind: "ready",
      native: { kind: "resume", sessionId: binding.nativeSessionId },
      nativeFingerprint: "a".repeat(64),
    });
    expect(host.state().executions.feedback).toMatchObject({
      kind: "attempt-started",
      driver: {
        harness: "codex",
        model: "native-model",
        effort: "high",
        provider: "native-provider",
        profile: "headless-turn",
      },
    });
    const notices = host.transcript().events.filter((entry) => entry.event.kind === "message");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.event).toMatchObject({
      text: "No interactive session detected. Resuming headlessly with session native-session.",
    });
    expect(Object.values(host.state().connection?.launches ?? {})).toHaveLength(1);
  } finally {
    preparation.close();
    f.close();
  }
});

test("a prepared native attempt reserves one HCN channel and cannot start a second process", async () => {
  const f = setup();
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const wire = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn });
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  let reading: Promise<unknown> | undefined;
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Use the same native session",
      turnId: "turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") throw new Error("Native preparation held");
    expect(prepared.nativeApprovals).toBeDefined();
    const responder = prepared.nativeApprovals;
    if (!responder) throw new Error("Missing current attempt responder");
    const options = {
      cwd: f.root,
      harness: "codex",
      prompt: prepared.prompt,
      resume: f.binding.nativeSessionId,
      turnId: "turn",
      nativeApprovals: responder,
    } as const;
    reading = wire.streamTurn(options)[Symbol.asyncIterator]().next();
    await expect(wire.streamTurn(options)[Symbol.asyncIterator]().next()).rejects.toThrow(
      "approval-unavailable",
    );
    expect(spawner.calls).toHaveLength(1);
    expect(proc.writes).toEqual([]);
    proc.exit(0);
    await reading;
    execution.turnSettled("turn");
    expect(f.host.state().executions.feedback).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "uncertain" },
    });
  } finally {
    proc.exit(0);
    await reading;
    execution.close();
    f.close();
  }
});
