import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createHeadlessHost, hostSeamFor, type SourceChannel } from "../../src/modes/host.js";
import { createManagedExecution } from "../../src/modes/managed-execution.js";
import { createManagedPreparation } from "../../src/modes/managed-preparation.js";
import { createManagedSource } from "../../src/modes/managed-source.js";
import { hasUnsettledNativeWork, type NativeBinding } from "../../src/protocol/connection.js";
import { observeConnection, readConnection } from "../../src/store/connection-view.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { registerNativeSession } from "../../src/store/native-registration.js";
import { acquirePresence, type PresenceHandle } from "../../src/store/presence.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

function setup(attachSource = true) {
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
  let lease: PresenceHandle | undefined;
  let onRecord = () => {};
  const host = createConversationHost(record.paths.dir, {
    connectionAuthority: () => binding,
    executorLease: () => lease?.held() === true,
    nativeSessionRoot: root,
    now: () => 1,
    onEffect: () => {},
    onRecord: () => onRecord(),
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
  const admitted = host.acquireExecutor(
    { binding, inputId: "feedback", kind: "native-headless" },
    () => acquirePresence(record.paths.dir, "native", { timeoutMs: 0 }),
  );
  if (admitted.verdict !== "accepted") throw new Error(admitted.issue);
  lease = admitted.lease;
  if (attachSource)
    expect(
      host.handleFrame(
        JSON.stringify({
          attachmentOrigin: "automatic",
          capabilities: ["managed-input-v1"],
          conversationId: "native",
          harness: "codex",
          kind: "attach",
          profile: "headless-turn",
          secret: record.secret,
          version: 1,
        }),
      ).verdict,
    ).toBe("accepted");
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
    observe: (callback: () => void) => {
      onRecord = callback;
    },
    setOwnerAlive: (alive: boolean) => {
      ownerAlive = alive;
    },
    close: () => {
      host.close();
      lease?.release();
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

test.each(["returning owner", "reconnect request"] as const)(
  "%s after preparation prevents HCN creation and proves no dispatch",
  async (change) => {
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
    try {
      const prepared = await execution.prepare({
        inputId: "feedback",
        text: "Use the same native session",
        turnId: "turn",
        native: { kind: "fresh" },
        profile: "headless-turn",
        signal: new AbortController().signal,
      });
      if (prepared.kind !== "ready" || !prepared.nativeApprovals)
        throw new Error("Preparation held");
      if (change === "returning owner") f.setOwnerAlive(true);
      else expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("accepted");
      proc.exit(0);
      await expect(
        wire
          .streamTurn({
            cwd: f.root,
            harness: "codex",
            nativeApprovals: prepared.nativeApprovals,
            prompt: prepared.prompt,
            resume: f.binding.nativeSessionId,
            turnId: "turn",
          })
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toThrow(change === "returning owner" ? "connection-conflict" : "execution-stale");
      expect(spawner.calls).toHaveLength(0);
      execution.turnSettled("turn");
      expect(f.host.state().executions.feedback).toMatchObject({
        kind: "attempt-ended",
        outcome: { kind: "pre-start-failed", failure: { evidence: "dispatch-not-called" } },
      });
      expect(Object.values(f.host.state().connection?.launches ?? {})).toEqual([
        expect.objectContaining({
          kind: "refused",
          failure: {
            code: "E-HUB-05",
            evidence: "dispatch-not-called",
            reason: expect.any(String),
          },
        }),
      ]);
      const settled = f.host.state();
      expect(f.host.recordNativeExecution({ kind: "settled", turnId: "turn" }).verdict).toBe(
        "accepted",
      );
      expect(f.host.state()).toEqual(settled);
      expect(f.host.transcript().inputs).toHaveLength(1);
    } finally {
      proc.exit(0);
      execution.close();
      f.close();
    }
  },
);

test("owned cleanup preserves an uncertain response and blocks later native work", async () => {
  const f = setup();
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Use the same native session",
      turnId: "lost-turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    if (prepared.kind !== "ready" || !prepared.nativeApprovals) throw new Error("Preparation held");
    // A synthetic invocation at the owned-execution seam ends without terminal evidence.
    prepared.nativeApprovals.dispatch?.(() => undefined);
    expect(
      execution.sendFrame({
        kind: "event",
        epoch: f.host.state().epoch,
        n: 1,
        turnId: "lost-turn",
        event: {
          kind: "identity",
          authority: "harness-minted",
          sessionId: f.binding.nativeSessionId,
        },
      }).verdict,
    ).toBe("accepted");
    execution.turnSettled("lost-turn");
    expect(f.host.state().executions.feedback).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "uncertain" },
    });
    expect(Object.values(f.host.state().connection?.launches ?? {})).toEqual([
      expect.objectContaining({
        kind: "settled",
        outcome: expect.objectContaining({ kind: "uncertain" }),
      }),
    ]);
    expect(hasUnsettledNativeWork(f.host.state())).toBe(true);
    expect(
      observeConnection(f.host.state(), {
        executorPresent: false,
        now: 1,
        ownerPresence: () => false,
      }),
    ).toMatchObject({ state: "outcome-unknown", reason: "execution-outcome-unverified" });
    expect(
      f.host.acceptInput({ id: "later", mode: "queue", text: "Next request" }, { managed: true })
        .verdict,
    ).toBe("accepted");
    const later = await execution.prepare({
      inputId: "later",
      text: "Next request",
      turnId: "later-turn",
      native: { kind: "resume", sessionId: f.binding.nativeSessionId },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    expect(later.kind).toBe("held");
    expect(Object.values(f.host.state().connection?.launches ?? {})).toHaveLength(1);
  } finally {
    execution.close();
    f.close();
  }
});

test("a document change after native preparation prevents dispatch of the stale context", async () => {
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
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Use the same native session",
      turnId: "turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    if (prepared.kind !== "ready" || !prepared.nativeApprovals) throw new Error("Preparation held");
    expect(
      (
        await f.host.writeArtifact({
          artifactId: "flow",
          author: "human",
          bytes: "<p>Edited after preparation</p>",
          contentType: "text/html",
          version: 1,
        })
      ).verdict,
    ).toBe("accepted");
    proc.exit(0);
    await expect(
      wire
        .streamTurn({
          cwd: f.root,
          harness: "codex",
          nativeApprovals: prepared.nativeApprovals,
          prompt: prepared.prompt,
          resume: f.binding.nativeSessionId,
          turnId: "turn",
        })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow("execution-stale");
    expect(spawner.calls).toHaveLength(0);
    execution.turnSettled("turn");
    expect(f.host.state().executions.feedback).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "pre-start-failed", failure: { evidence: "dispatch-not-called" } },
    });
    expect(f.host.readArtifact("flow", 1)?.bytes).toBe("<p>Edited after preparation</p>");
  } finally {
    proc.exit(0);
    execution.close();
    f.close();
  }
});

test("an admitted native source records one approval answer and completes the same-session response", async () => {
  const f = setup(false);
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const spawned = Promise.withResolvers<void>();
  const announced = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const requestId = randomUUID();
  f.observe(() => {
    if (
      f.host
        .transcript()
        .events.some(
          ({ event }) => event.kind === "identity" && event.authority === "caller-assigned",
        )
    )
      announced.resolve();
    if (f.host.state().approvals[requestId]) requested.resolve();
    if (f.host.state().completedTurns["source-turn-1"] !== undefined) terminal.resolve();
    if (f.host.state().executions.feedback?.kind === "attempt-ended") completed.resolve();
  });
  const wire = createHcnRunner({
    bin: "/fake/hcn",
    spawn: (argv, options) => {
      const child = spawner.spawn(argv, options);
      spawned.resolve();
      return child;
    },
  });
  let source: SourceChannel | undefined;
  let turns = 0;
  try {
    source = createManagedSource(
      {
        ...f.driver,
        conversationId: "native",
        cwd: f.root,
        host: hostSeamFor(f.host),
        mintTurnId: () => `source-turn-${++turns}`,
        runner: { ...f.runner, streamTurn: wire.streamTurn },
        secret: f.host.state().secret,
        sendFrame: (frame) => f.host.handleFrame(JSON.stringify(frame)),
      },
      "headless-turn",
      f.host,
      createHeadlessHost,
    );
    await spawned.promise;
    // Synthetic normalized HCN events, not a captured native recording.
    // HCN first announces the caller's requested ID, before native confirmation.
    proc.emit({
      kind: "identity",
      sessionId: f.binding.nativeSessionId,
      authority: "caller-assigned",
    });
    await announced.promise;
    expect(Object.values(f.host.state().connection?.launches ?? {})).toEqual([
      expect.objectContaining({ kind: "intended" }),
    ]);
    expect(f.host.state().executions.feedback?.kind).toBe("attempt-started");
    proc.emit({
      kind: "identity",
      sessionId: f.binding.nativeSessionId,
      authority: "harness-minted",
    });
    proc.emit({
      kind: "approval-request",
      v: 1,
      requestId,
      sessionId: f.binding.nativeSessionId,
      turnId: "native-turn",
      category: "command",
      details: "Command: echo fixture",
      choices: [{ id: "deny", label: "Deny", scope: "deny" }],
    });
    await requested.promise;
    expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("accepted");
    const reconnectId = f.host.state().connection?.reconnectId;
    expect(reconnectId).toBeString();
    expect(Object.values(f.host.state().connection?.launches ?? {})).toEqual([
      expect.objectContaining({ kind: "started", identitySeq: expect.any(Number) }),
    ]);
    expect(proc.writes).toEqual([]);
    const decision = { id: randomUUID(), requestId, choiceId: "deny" };
    expect(f.host.decideApproval(decision).verdict).toBe("accepted");
    source.recordChanged?.();
    source.recordChanged?.();
    expect(proc.commands).toEqual([{ ...decision, op: "approval", v: 1 }]);
    proc.emit({ kind: "approval-disposition", v: 1, id: decision.id, requestId, status: "sent" });
    proc.emit({
      kind: "message",
      role: "assistant",
      text: "The command was denied. Here is the response.",
    });
    proc.emit({ kind: "done", cause: "clean", exitCode: 0 });
    await terminal.promise;
    expect(Object.values(f.host.state().connection?.launches ?? {})).toEqual([
      expect.objectContaining({ kind: "started" }),
    ]);
    expect(f.host.state().executions.feedback?.kind).toBe("attempt-started");
    proc.exit(0);
    await completed.promise;
    expect(Object.values(f.host.state().connection?.launches ?? {})).toEqual([
      expect.objectContaining({
        kind: "settled",
        outcome: { kind: "completed", terminalSeq: expect.any(Number) },
      }),
    ]);
    expect(f.host.state().executions.feedback).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "completed" },
      start: { native: { kind: "resume", sessionId: f.binding.nativeSessionId } },
    });
    expect(f.host.contextCoverage("codex", f.binding.nativeSessionId)).toBeGreaterThan(0);
    expect(f.host.state().connection?.reconnectId).toBe(reconnectId);
    expect(hasUnsettledNativeWork(f.host.state())).toBe(true);
    expect(
      f.host
        .transcript()
        .events.some(
          ({ event }) =>
            event.kind === "message" &&
            event.text === "The command was denied. Here is the response.",
        ),
    ).toBe(true);
    expect(spawner.calls).toHaveLength(1);
  } finally {
    proc.exit(0);
    source?.close();
    await source?.settled;
    f.close();
  }
});

test("current owned native work projects starting, responding and cleanup as separate states", async () => {
  const f = setup();
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  const status = () =>
    readConnection(f.host.dir, {
      now: () => 1,
      ownerPresence: (owner) => owner.pid === process.pid,
    });
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Use the same native session",
      turnId: "projection-turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    if (prepared.kind !== "ready" || !prepared.nativeApprovals) throw new Error("Preparation held");
    expect(status()).toMatchObject({ state: "headless-starting" });
    prepared.nativeApprovals.dispatch?.(() => undefined);
    expect(
      execution.sendFrame({
        kind: "event",
        epoch: f.host.state().epoch,
        n: 1,
        turnId: "projection-turn",
        event: {
          kind: "identity",
          authority: "harness-minted",
          sessionId: f.binding.nativeSessionId,
        },
      }).verdict,
    ).toBe("accepted");
    expect(status()).toMatchObject({ state: "headless-running" });
    expect(
      execution.sendFrame({
        kind: "event",
        epoch: f.host.state().epoch,
        n: 2,
        turnId: "projection-turn",
        event: { kind: "done", cause: "clean", exitCode: 0 },
      }).verdict,
    ).toBe("accepted");
    expect(status()).toMatchObject({ state: "cleanup" });
    expect(status().inputs[0]).toMatchObject({ state: "finished", outcome: null });
    expect(status().inputs[0]?.message).toContain("no reply was recorded");
    execution.turnSettled("projection-turn");
    expect(status()).toMatchObject({ state: "closed" });
  } finally {
    execution.close();
    f.close();
  }
});

test.each(["unknown-owner", "unknown-lock"] as const)(
  "%s cannot project a native launch as currently starting",
  async (missing) => {
    const f = setup();
    const preparation = createManagedPreparation({
      cwd: f.root,
      driver: f.driver,
      host: f.host,
      runner: f.runner,
    });
    try {
      const prepared = await preparation.prepare({
        inputId: "feedback",
        text: "Use the same native session",
        turnId: "unknown-status",
        native: { kind: "fresh" },
        profile: "headless-turn",
        signal: new AbortController().signal,
      });
      expect(prepared.kind).toBe("ready");
      expect(
        observeConnection(f.host.state(), {
          executorPresent: missing === "unknown-lock" ? undefined : true,
          now: 1,
          ownerPresence: (owner) =>
            owner.pid === process.pid ? (missing === "unknown-owner" ? undefined : true) : false,
        }),
      ).toMatchObject({
        state: "owner-unknown",
        reason: missing === "unknown-owner" ? "headless-owner-unverified" : "executor-unverified",
      });
    } finally {
      preparation.close();
      f.close();
    }
  },
);

test("native registration stays serialized through the HCN creation callback", async () => {
  const f = setup();
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  let registration: ReturnType<typeof registerNativeSession> | undefined;
  const wire = createHcnRunner({
    bin: "/fake/hcn",
    spawn: (argv, options) => {
      registration = registerNativeSession(
        f.root,
        {
          ...f.binding,
          owner: { ...f.binding.owner, pid: 456 },
        },
        { callerOwns: () => true, ownerPresence: () => true },
      );
      return spawner.spawn(argv, options);
    },
  });
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Use the same native session",
      turnId: "turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    if (prepared.kind !== "ready" || !prepared.nativeApprovals) throw new Error("Preparation held");
    proc.exit(0);
    await wire
      .streamTurn({
        cwd: f.root,
        harness: "codex",
        nativeApprovals: prepared.nativeApprovals,
        prompt: prepared.prompt,
        resume: f.binding.nativeSessionId,
        turnId: "turn",
      })
      [Symbol.asyncIterator]()
      .next();
    expect(registration).toMatchObject({ ok: false, reason: "registration-busy" });
    expect(spawner.calls).toHaveLength(1);
  } finally {
    proc.exit(0);
    execution.close();
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

test("headless message delivery uses receipt and correlated terminal evidence, not process identity", async () => {
  const f = setup();
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  let known = true;
  const delivery = () =>
    readConnection(f.host.dir, {
      now: () => 1,
      ownerPresence: (owner) => (known ? owner.pid === process.pid : undefined),
    }).inputs.find((input) => input.inputId === "feedback");
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Review",
      turnId: "delivery-turn",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    if (prepared.kind !== "ready" || !prepared.nativeApprovals) throw new Error("Preparation held");
    expect(delivery()).toMatchObject({ state: "sending", outcome: null });
    prepared.nativeApprovals.dispatch?.(() => undefined);
    expect(
      execution.sendFrame({
        kind: "event",
        epoch: f.host.state().epoch,
        n: 1,
        turnId: "delivery-turn",
        event: {
          kind: "identity",
          authority: "harness-minted",
          sessionId: f.binding.nativeSessionId,
        },
      }).verdict,
    ).toBe("accepted");
    expect(delivery()).toMatchObject({ state: "sending", outcome: null });
    known = false;
    expect(delivery()).toMatchObject({ state: "delivery-uncertain" });
    known = true;
    expect(
      execution.sendFrame({
        kind: "disposition",
        epoch: f.host.state().epoch,
        inputId: "feedback",
        outcome: "applied",
      }).verdict,
    ).toBe("accepted");
    expect(delivery()).toMatchObject({ state: "received", outcome: null });
    known = false;
    expect(delivery()?.message).toContain("outcome is unknown");
    known = true;
    expect(
      execution.sendFrame({
        kind: "event",
        epoch: f.host.state().epoch,
        n: 2,
        turnId: "delivery-turn",
        event: { kind: "question", question: "Which section?" },
      }).verdict,
    ).toBe("accepted");
    expect(delivery()).toMatchObject({ state: "received" });
    expect(
      execution.sendFrame({
        kind: "event",
        epoch: f.host.state().epoch,
        n: 3,
        turnId: "delivery-turn",
        event: { kind: "done", cause: "awaiting-input", exitCode: 0 },
      }).verdict,
    ).toBe("accepted");
    expect(delivery()).toMatchObject({
      state: "finished",
      outcome: { kind: "question", text: "Which section?" },
    });
    execution.turnSettled("delivery-turn");
    known = false;
    expect(delivery()).toMatchObject({
      state: "finished",
      outcome: { kind: "question", text: "Which section?" },
    });
  } finally {
    execution.close();
    f.close();
  }
});

test("a headless refusal before execution reports not started and retains its recorded reason", async () => {
  const f = setup();
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Review",
      turnId: "refused-delivery",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    expect(prepared.kind).toBe("ready");
    execution.dispatchRejected("refused-delivery", "harness-refusal");
    execution.turnSettled("refused-delivery");
    const status = readConnection(f.host.dir, { ownerPresence: () => false });
    expect(status.inputs[0]).toMatchObject({ state: "not-started", outcome: { kind: "refusal" } });
    expect(status.inputs[0]?.message).toContain("refused the invocation before task execution");
  } finally {
    execution.close();
    f.close();
  }
});

test("a failed headless response keeps the terminal failure and never becomes response finished", async () => {
  const f = setup();
  const execution = createManagedExecution({
    cwd: f.root,
    driver: f.driver,
    host: f.host,
    runner: f.runner,
  });
  try {
    const prepared = await execution.prepare({
      inputId: "feedback",
      text: "Review",
      turnId: "failed-delivery",
      native: { kind: "fresh" },
      profile: "headless-turn",
      signal: new AbortController().signal,
    });
    if (prepared.kind !== "ready" || !prepared.nativeApprovals) throw new Error("Preparation held");
    prepared.nativeApprovals.dispatch?.(() => undefined);
    const epoch = f.host.state().epoch;
    expect(
      execution.sendFrame({
        kind: "event",
        epoch,
        n: 1,
        turnId: "failed-delivery",
        event: {
          kind: "identity",
          authority: "harness-minted",
          sessionId: f.binding.nativeSessionId,
        },
      }).verdict,
    ).toBe("accepted");
    expect(
      execution.sendFrame({ kind: "disposition", epoch, inputId: "feedback", outcome: "applied" })
        .verdict,
    ).toBe("accepted");
    expect(
      execution.sendFrame({
        kind: "event",
        epoch,
        n: 2,
        turnId: "failed-delivery",
        event: { kind: "failure", class: "failure", message: "The model request failed." },
      }).verdict,
    ).toBe("accepted");
    expect(
      execution.sendFrame({
        kind: "event",
        epoch,
        n: 3,
        turnId: "failed-delivery",
        event: { kind: "done", cause: "error", exitCode: 1 },
      }).verdict,
    ).toBe("accepted");
    execution.turnSettled("failed-delivery");
    const status = readConnection(f.host.dir, { ownerPresence: () => false });
    expect(status.inputs[0]).toMatchObject({
      state: "finished",
      outcome: { kind: "failure", text: "The model request failed." },
    });
  } finally {
    execution.close();
    f.close();
  }
});
