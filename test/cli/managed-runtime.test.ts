import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedWorker } from "../../src/cli/managed-worker.js";
import { openDrivenConversation } from "../../src/cli/runtime.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";

const SYNTHETIC_HCN_IDENTITY = "synthetic";

import { recoveryPolicy } from "../../src/protocol/execution.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

async function until(check: () => boolean): Promise<void> {
  for (let tick = 0; tick < 300 && !check(); tick++) await Bun.sleep(1);
  expect(check()).toBe(true);
}
function fixture(managedWorkspace = false, nativeManagement = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-managed-runtime-")));
  const { paths, secret } = createConversationRecord(root, "managed", {
    workingDirectory: managedWorkspace ? null : root,
  });
  const driver = {
    harness: nativeManagement ? "codex" : "claude",
    model: "selected",
    effort: "high",
    profile: "headless-turn",
  } as const;
  replaceSettings(paths.dir, "managed", 0, driver);
  const writer = createConversationHost(paths.dir, {
    now: () => Date.now(),
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  writer.acceptInput({ id: "one", text: "First request", mode: "queue" }, { managed: true });
  writer.close();
  const procs = Array.from({ length: 3 }, () => new FakeHcnProcess());
  const spawner = fakeSpawner(procs);
  const hcn = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn, refusalGraceMs: 1 });
  const runner: HarnessRunner = {
    ...hcn,
    inspect: async (harness) => ({
      name: harness,
      ...(nativeManagement ? { nativeContextManagement: true as const } : {}),
      session: false,
      verifiedAgainst: "verified",
      runtime: {
        executable: { path: "/fake/harness", version: "verified" },
        resume: { status: "supported", reason: null },
      },
    }),
    countContext: async (request) => {
      if (nativeManagement) throw new Error("Native management must not request accounting");
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: request.model ?? "selected",
        inputLimitTokens: 10000,
        totalTokens: 1000,
      };
    },
  };
  return {
    root,
    paths,
    secret,
    procs,
    spawner,
    runner,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "managed runtime dispatches and resumes: managed workspace %s, native management %s",
  async (managedWorkspace, nativeManagement) => {
    const f = fixture(managedWorkspace, nativeManagement);
    const harness = nativeManagement ? "codex" : "claude";
    const running = await openDrivenConversation({
      rootDir: f.root,
      conversationId: "managed",
      managed: true,
      runner: f.runner,
      harnessName: "muse",
      presence: () => false,
    });
    if (running.kind !== "running") throw new Error("Worker did not start");
    try {
      await until(() => f.spawner.calls.length === 1);
      expect(running.host.state().attachment).toMatchObject({
        capabilities: ["managed-input-v1"],
        attachmentOrigin: "automatic",
      });
      expect(running.host.state().executions.one?.kind).toBe("attempt-started");
      expect(f.spawner.calls[0]?.argv).toContain(harness);
      expect(f.spawner.calls[0]?.opts.cwd).toBe(
        managedWorkspace ? join(f.paths.dir, "workspace") : f.root,
      );
      const first = f.procs[0];
      if (!first) throw new Error("Missing first process");
      first.emit({ kind: "identity", sessionId: "same-native", authority: "harness-minted" });
      first.emit({ kind: "message", role: "assistant", text: "First answer" });
      first.emit({ kind: "done", cause: "clean", exitCode: 0 });
      first.exit(0);
      await until(() => running.host.state().executions.one?.kind === "attempt-ended");
      expect(running.host.contextCoverage(harness, "same-native")).toBeGreaterThan(0);
      expect(
        running.host.acceptInput(
          { id: "two", text: "Second request", mode: "queue" },
          { managed: true },
        ).verdict,
      ).toBe("accepted");
      await until(() => f.spawner.calls.length === 2);
      const args = f.spawner.calls[1]?.argv ?? [];
      expect(args[args.indexOf("--resume") + 1]).toBe("same-native");
      const second = f.procs[1];
      if (!second) throw new Error("Missing second process");
      second.emit({ kind: "identity", sessionId: "same-native", authority: "harness-minted" });
      second.emit({ kind: "message", role: "assistant", text: "Second answer" });
      second.emit({ kind: "done", cause: "clean", exitCode: 0 });
      second.exit(0);
      await until(() => running.host.state().executions.two?.kind === "attempt-ended");
      expect(running.host.transcript().inputs).toHaveLength(2);
    } finally {
      running.abort();
      await running.done;
      f.close();
    }
  },
);

test("managed runtime cannot create a missing record", async () => {
  const f = fixture();
  try {
    await expect(
      openDrivenConversation({
        rootDir: f.root,
        conversationId: "missing",
        managed: true,
        runner: f.runner,
      }),
    ).rejects.toThrow();
    expect(f.spawner.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("managed runtime records uncertainty when its active process is stopped", async () => {
  const f = fixture();
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  try {
    await until(() => f.spawner.calls.length === 1);
    f.procs[0]?.emit({
      kind: "identity",
      sessionId: "uncertain-native",
      authority: "harness-minted",
    });
    running.abort();
    await running.done;
    expect(running.host.state().executions.one).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "uncertain" },
    });
    expect(running.host.contextCoverage("claude", "uncertain-native")).toBe(0);
    expect(f.procs[0]?.signals).toContain("SIGTERM");
    expect(running.presenceHeld()).toBe(false);
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("explicit fresh recovery reuses an applied input and carries its partial history", async () => {
  const f = fixture();
  const first = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (first.kind !== "running") throw new Error("Worker did not start");
  try {
    await until(() => f.spawner.calls.length === 1);
    f.procs[0]?.emit({ kind: "identity", sessionId: "old-native", authority: "harness-minted" });
    f.procs[0]?.emit({
      kind: "message",
      role: "assistant",
      text: "Partial work before interruption",
    });
    await until(() => first.host.state().harnessSessions.claude === "old-native");
    first.abort();
    await first.done;
    const writer = createConversationHost(f.paths.dir, {
      now: () => Date.now(),
      executorLease: () => false,
      presence: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(
      writer.writeExecution({
        kind: "fresh-authorized",
        inputId: "one",
        attempt: 1,
        actionId: "fresh-action",
        acknowledgeEffects: true,
      }).verdict,
    ).toBe("accepted");
    writer.close();
    const second = await openDrivenConversation({
      rootDir: f.root,
      conversationId: "managed",
      managed: true,
      runner: f.runner,
      presence: () => false,
    });
    if (second.kind !== "running") throw new Error("Recovery did not start");
    try {
      await until(() => f.spawner.calls.length === 2);
      expect(f.spawner.calls[1]?.argv).not.toContain("--resume");
      expect(f.procs[1]?.writes.join("")).toContain("Partial work before interruption");
      expect(f.procs[1]?.writes.join("")).toContain("Inspect the current workspace state");
      expect(second.host.state().executions.one).toMatchObject({
        kind: "attempt-started",
        attempt: 2,
        native: { kind: "fresh" },
      });
      expect(second.host.transcript().inputs).toHaveLength(1);
      f.procs[1]?.emit({ kind: "identity", sessionId: "new-native", authority: "harness-minted" });
      f.procs[1]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
      f.procs[1]?.exit(0);
      await until(() => second.host.state().executions.one?.kind === "attempt-ended");
      expect(second.host.contextCoverage("claude", "old-native")).toBe(0);
      expect(second.host.contextCoverage("claude", "new-native")).toBeGreaterThan(0);
    } finally {
      second.abort();
      await second.done;
    }
  } finally {
    first.abort();
    await first.done;
    f.close();
  }
});

test("managed session prepares and settles consecutive turns on its persistent process", async () => {
  const f = fixture();
  replaceSettings(f.paths.dir, "managed", 1, {
    harness: "claude",
    model: "selected",
    effort: "high",
    profile: "headless-session",
  });
  const runner: HarnessRunner = {
    ...f.runner,
    inspect: async (h, choice) => ({ ...(await f.runner.inspect(h, choice)), session: true }),
  };
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  const proc = f.procs[0];
  if (!proc) throw new Error("Missing process");
  try {
    await until(() => f.spawner.calls.length === 1);
    proc.emit({
      kind: "session",
      sessionId: "persistent-native",
      harness: "claude",
      hcn: SYNTHETIC_HCN_IDENTITY,
    });
    await until(() =>
      proc.commands.some((command) => command.op === "send" && command.id === "one"),
    );
    proc.emit({ kind: "disposition", id: "one", disposition: "started" });
    proc.emit({ kind: "turn", turnId: "hcn-one", id: "one" });
    proc.emit({ kind: "identity", sessionId: "persistent-native", authority: "harness-minted" });
    proc.emit({ kind: "message", role: "assistant", text: "First session answer" });
    proc.emit({ kind: "done", cause: "clean", exitCode: null });
    await until(() => running.host.state().executions.one?.kind === "attempt-ended");
    expect(
      running.host.acceptInput(
        { id: "two", text: "Next session request", mode: "queue" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    await until(() =>
      proc.commands.some((command) => command.op === "send" && command.id === "two"),
    );
    proc.emit({ kind: "disposition", id: "two", disposition: "started" });
    proc.emit({ kind: "turn", turnId: "hcn-two", id: "two" });
    proc.emit({ kind: "identity", sessionId: "persistent-native", authority: "harness-minted" });
    proc.emit({ kind: "done", cause: "clean", exitCode: null });
    await until(() => running.host.state().executions.two?.kind === "attempt-ended");
    expect(f.spawner.calls).toHaveLength(1);
    expect(running.host.contextCoverage("claude", "persistent-native")).toBeGreaterThan(0);
  } finally {
    running.abort();
    proc.emit({ kind: "closed", exitCode: 0, cause: "closed" });
    proc.exit(0);
    await running.done;
    f.close();
  }
});

test.each([true, false])(
  "takeover settles abandoned attempt, terminal proof present: %s",
  async (completed) => {
    const f = fixture();
    const prior = createConversationHost(f.paths.dir, {
      now: () => 1,
      executorLease: () => true,
      presence: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(
      prior.handleFrame(
        JSON.stringify({
          kind: "attach",
          conversationId: "managed",
          secret: f.secret,
          version: 1,
          harness: "claude",
          profile: "headless-turn",
          capabilities: ["managed-input-v1"],
          attachmentOrigin: "automatic",
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      prior.writeExecution({
        kind: "attempt-started",
        inputId: "one",
        epoch: 1,
        attempt: 1,
        turnId: "old-turn",
        driver: { harness: "claude", model: "selected", effort: "high", profile: "headless-turn" },
        native: { kind: "fresh" },
        context: { from: 0, through: 1, digest: "a".repeat(64) },
      }).verdict,
    ).toBe("accepted");
    prior.handleFrame(
      JSON.stringify({ kind: "disposition", epoch: 1, inputId: "one", outcome: "applied" }),
    );
    prior.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "old-turn",
        event: { kind: "identity", sessionId: "lost-native", authority: "harness-minted" },
      }),
    );
    if (completed)
      prior.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 2,
          turnId: "old-turn",
          event: { kind: "done", cause: "clean", exitCode: 0 },
        }),
      );
    prior.close();
    const running = await openDrivenConversation({
      rootDir: f.root,
      conversationId: "managed",
      managed: true,
      runner: f.runner,
      presence: () => false,
      now: () => 1_000_000,
    });
    if (running.kind !== "running") throw new Error("Recovery did not start");
    try {
      expect(running.host.state().executions.one).toMatchObject({
        kind: "attempt-ended",
        attempt: 1,
        outcome: { kind: completed ? "completed" : "uncertain" },
      });
      expect(f.spawner.calls).toHaveLength(0);
      expect(running.host.transcript().inputs).toHaveLength(1);
      expect(running.host.contextCoverage("claude", "lost-native") > 0).toBe(completed);
    } finally {
      running.abort();
      await running.done;
      f.close();
    }
  },
);

test("a managed model change resumes the selected harness native session", async () => {
  const f = fixture();
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  try {
    await until(() => f.spawner.calls.length === 1);
    f.procs[0]?.emit({ kind: "identity", sessionId: "model-native", authority: "harness-minted" });
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    await until(() => running.host.state().executions.one?.kind === "attempt-ended");
    replaceSettings(f.paths.dir, "managed", 1, {
      harness: "claude",
      model: "different",
      effort: "high",
      profile: "headless-turn",
    });
    running.host.acceptInput(
      { id: "two", text: "Continue with the selected model", mode: "queue" },
      { managed: true },
    );
    await until(() => f.spawner.calls.length === 2);
    const args = f.spawner.calls[1]?.argv ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("different");
    expect(args[args.indexOf("--resume") + 1]).toBe("model-native");
    expect(running.host.state().executions.two).toMatchObject({
      kind: "attempt-started",
      driver: { model: "different" },
      native: { kind: "resume", sessionId: "model-native" },
    });
    f.procs[1]?.emit({ kind: "identity", sessionId: "model-native", authority: "harness-minted" });
    f.procs[1]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[1]?.exit(0);
    await until(() => running.host.state().executions.two?.kind === "attempt-ended");
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("a harness switch transfers history and returning resumes only that harness session", async () => {
  const f = fixture();
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  const answer = async (index: number, id: string, native: string, text: string): Promise<void> => {
    const proc = f.procs[index];
    if (!proc) throw new Error("Missing process");
    proc.emit({ kind: "identity", sessionId: native, authority: "harness-minted" });
    proc.emit({ kind: "message", role: "assistant", text });
    proc.emit({ kind: "done", cause: "clean", exitCode: 0 });
    proc.exit(0);
    await until(() => running.host.state().executions[id]?.kind === "attempt-ended");
  };
  try {
    await until(() => f.spawner.calls.length === 1);
    await answer(0, "one", "claude-native", "Initial harness answer");
    replaceSettings(f.paths.dir, "managed", 1, {
      harness: "codex",
      model: "codex-model",
      effort: "high",
      profile: "headless-turn",
    });
    running.host.acceptInput(
      { id: "two", text: "Continue in Codex", mode: "queue" },
      { managed: true },
    );
    await until(() => f.spawner.calls.length === 2);
    expect(f.spawner.calls[1]?.argv).not.toContain("--resume");
    expect(f.procs[1]?.writes.join("")).toContain("Initial harness answer");
    await answer(1, "two", "codex-native", "Other harness answer");
    replaceSettings(f.paths.dir, "managed", 2, {
      harness: "claude",
      model: "selected",
      effort: "high",
      profile: "headless-turn",
    });
    running.host.acceptInput(
      { id: "three", text: "Return to Claude", mode: "queue" },
      { managed: true },
    );
    await until(() => f.spawner.calls.length === 3);
    const args = f.spawner.calls[2]?.argv ?? [];
    expect(args[args.indexOf("--resume") + 1]).toBe("claude-native");
    expect(args).not.toContain("codex-native");
    expect(f.procs[2]?.writes.join("")).toContain("Other harness answer");
    expect(f.procs[2]?.writes.join("")).not.toContain("Initial harness answer");
    await answer(2, "three", "claude-native", "Returned harness answer");
    expect(running.host.transcript().inputs).toHaveLength(3);
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("cancelling initial inspection stops the worker before a task process is created", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  let cancelled = false;
  const opening = openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    signal: controller.signal,
    runner: {
      ...f.runner,
      inspect: (_harness, choice) =>
        new Promise((_resolve, reject) => {
          choice?.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled inspection"));
            },
            { once: true },
          );
          started.resolve();
        }),
    },
    presence: () => false,
  });
  try {
    await started.promise;
    controller.abort();
    await expect(opening).rejects.toThrow("cancelled inspection");
    expect(cancelled).toBe(true);
    expect(f.spawner.calls).toHaveLength(0);
  } finally {
    controller.abort();
    f.close();
  }
});

test("a managed session's explicit send refusal is safe to retry without acknowledging effects", async () => {
  const f = fixture();
  replaceSettings(f.paths.dir, "managed", 1, {
    harness: "claude",
    model: "selected",
    effort: "high",
    profile: "headless-session",
  });
  const runner: HarnessRunner = {
    ...f.runner,
    inspect: async (h, choice) => ({ ...(await f.runner.inspect(h, choice)), session: true }),
  };
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  const proc = f.procs[0];
  if (!proc) throw new Error("Missing process");
  try {
    await until(() => f.spawner.calls.length === 1);
    proc.emit({
      kind: "session",
      sessionId: "persistent-native",
      harness: "claude",
      hcn: SYNTHETIC_HCN_IDENTITY,
    });
    await until(() => proc.commands.some((command) => command.op === "send"));
    proc.emit({
      kind: "disposition",
      id: "one",
      disposition: "rejected",
      reason: "selected model unavailable",
    });
    proc.emit({ kind: "closed", exitCode: 2, cause: "closed" });
    proc.exit(2);
    await running.done;
    const writer = createConversationHost(f.paths.dir, {
      now: Date.now,
      presence: () => false,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      expect(writer.state().executions.one).toMatchObject({
        kind: "attempt-ended",
        outcome: { kind: "pre-start-failed" },
      });
      expect(
        writer.writeExecution({
          kind: "retry-authorized",
          inputId: "one",
          attempt: 1,
          actionId: "retry",
          acknowledgeEffects: false,
        }).verdict,
      ).toBe("accepted");
    } finally {
      writer.close();
    }
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("a missing folder holds without consuming an attempt and a folder remedy releases the original prompt", async () => {
  const f = fixture();
  const { replaceLocation } = await import("../../src/store/settings.js");
  const { runManagedWorker } = await import("../../src/cli/managed-worker.js");
  const { viewSnapshot } = await import("../../src/store/conversation-host.js");
  const { managedCandidates } = await import("../../src/store/managed-readiness.js");
  const { mkdirSync } = await import("node:fs");
  const folder = join(f.root, "gone");
  mkdirSync(folder);
  replaceLocation(f.paths.dir, "managed", 0, folder);
  rmSync(folder, { recursive: true });
  try {
    await runManagedWorker(f.root, "managed", "one", { runner: f.runner });
    expect(viewSnapshot(f.paths.dir).state.executions.one).toMatchObject({
      kind: "held",
      attempt: 0,
      hold: { code: "E-HUB-04" },
    });
    expect(managedCandidates(f.paths.dir, viewSnapshot(f.paths.dir).state)).toEqual([]);
    await runManagedWorker(f.root, "managed", "one", { runner: f.runner });
    expect(f.spawner.calls).toHaveLength(0);
    replaceLocation(f.paths.dir, "managed", 1, f.root);
    expect(managedCandidates(f.paths.dir, viewSnapshot(f.paths.dir).state)).toEqual(["one"]);
    const worker = runManagedWorker(f.root, "managed", "one", {
      runner: f.runner,
      idleMs: 5,
      tickMs: 1,
    });
    await until(() => f.spawner.calls.length === 1);
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    await worker;
    expect(viewSnapshot(f.paths.dir).state.executions.one).toMatchObject({
      kind: "attempt-ended",
      attempt: 1,
      outcome: { kind: "completed" },
    });
    expect(viewSnapshot(f.paths.dir).transcript.inputs).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("HTTP recovery preserves an uncertain input and rejects unsafe or changed actions", async () => {
  const f = fixture();
  const { startServer } = await import("../../src/server/server.js");
  const { viewSnapshot } = await import("../../src/store/conversation-host.js");
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  await until(() => f.spawner.calls.length === 1);
  f.procs[0]?.emit({ kind: "message", role: "assistant", text: "Partial recorded work" });
  await until(() =>
    running.host.transcript().events.some((event) => event.event.kind === "message"),
  );
  running.abort();
  await running.done;
  const server = await startServer({
    rootDir: f.root,
    port: 0,
    runner: f.runner,
    managedLaunch: { request: () => {} },
  });
  const recover = (action: string, acknowledgeEffects: boolean, expectedAttempt = 1) =>
    fetch(`${server.url}/api/conversations/managed/inputs/one/recovery`, {
      method: "POST",
      headers: { "x-lucid-token": server.token, "content-type": "application/json" },
      body: JSON.stringify({
        action,
        acknowledgeEffects,
        expectedAttempt,
        actionId: "same-action",
      }),
    });
  try {
    const read = await fetch(`${server.url}/api/conversations/managed`, {
      headers: { "x-lucid-token": server.token },
    });
    expect((await read.json()).executions).toMatchObject([
      {
        inputId: "one",
        status: "uncertain",
        acknowledgeEffects: true,
        actions: ["continue-fresh"],
      },
    ]);
    expect((await recover("retry", false)).status).toBe(409);
    expect((await recover("continue-fresh", false)).status).toBe(409);
    expect((await recover("continue-fresh", true, 0)).status).toBe(409);
    const { mkdirSync } = await import("node:fs");
    const { replaceLocation } = await import("../../src/store/settings.js");
    const unavailable = join(f.root, "recovery-folder");
    mkdirSync(unavailable);
    replaceLocation(f.paths.dir, "managed", 0, unavailable);
    rmSync(unavailable, { recursive: true });
    const held = await fetch(`${server.url}/api/conversations/managed`, {
      headers: { "x-lucid-token": server.token },
    });
    expect((await held.json()).executions[0].actions).toEqual([]);
    expect((await recover("continue-fresh", true)).status).toBe(409);
    replaceLocation(f.paths.dir, "managed", 1, f.root);
    expect((await recover("continue-fresh", true)).status).toBe(200);
    expect((await recover("continue-fresh", true)).status).toBe(200);
    expect((await recover("continue-fresh", false)).status).toBe(409);
    expect(viewSnapshot(f.paths.dir).transcript.inputs).toHaveLength(1);
    expect(viewSnapshot(f.paths.dir).state.executions.one).toMatchObject({
      kind: "fresh-authorized",
      attempt: 1,
    });
    expect(f.spawner.calls).toHaveLength(1);
  } finally {
    await server.close();
    f.close();
  }
});

test("an explicit terminal run adopts managed intents and records one attachment intent", async () => {
  const f = fixture();
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Did not attach");
  try {
    await until(() => f.spawner.calls.length === 1);
    expect(running.host.state().attachment).toMatchObject({
      attachmentOrigin: "explicit",
      capabilities: ["managed-input-v1"],
    });
    expect(Object.keys(running.host.state().explicitAttachments)).toHaveLength(1);
    expect(running.host.state().executions.one?.kind).toBe("attempt-started");
    f.procs[0]?.emit({
      kind: "identity",
      sessionId: "terminal-native",
      authority: "harness-minted",
    });
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    await until(() => running.host.state().executions.one?.kind === "attempt-ended");
    running.host.enqueueInput({
      id: "terminal-prompt",
      text: "Continue from the terminal",
      mode: "queue",
    });
    await until(() => f.spawner.calls.length === 2);
    expect(running.host.state().executions["terminal-prompt"]?.kind).toBe("attempt-started");
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("a concurrent accepted prompt does not strand or overtake the preparing prompt", async () => {
  const f = fixture();
  let firstCount = true;
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async (request) => {
      if (firstCount) {
        firstCount = false;
        const writer = createConversationHost(f.paths.dir, {
          now: Date.now,
          presence: () => true,
          executorLease: () => false,
          onEffect: () => {},
          onRecord: () => {},
        });
        writer.acceptInput(
          { id: "two", text: "Concurrent second request", mode: "queue" },
          { managed: true },
        );
        writer.close();
      }
      return f.runner.countContext(request);
    },
  };
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Did not attach");
  try {
    await until(() => f.spawner.calls.length === 1);
    expect(running.host.state().executions.one?.kind).toBe("attempt-started");
    expect(running.host.state().executions.two?.kind).toBe("requested");
    f.procs[0]?.emit({
      kind: "identity",
      sessionId: "ordered-native",
      authority: "harness-minted",
    });
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    await until(() => f.spawner.calls.length === 2);
    expect(running.host.state().executions.two?.kind).toBe("attempt-started");
    expect(running.host.contextCoverage("claude", "ordered-native")).toBeLessThan(
      running.host.state().completedTurns[
        Object.keys(running.host.state().completedTurns)[0] ?? ""
      ] ?? 0,
    );
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("a completed resumed turn with a different identity keeps coverage unconfirmed and accepts later work", async () => {
  const f = fixture();
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Did not attach");
  try {
    for (let index = 0; index < 2; index++) {
      await until(() => f.spawner.calls.length === index + 1);
      f.procs[index]?.emit({
        kind: "identity",
        sessionId: index === 0 ? "original" : "different",
        authority: "harness-minted",
      });
      f.procs[index]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
      f.procs[index]?.exit(0);
      await until(
        () =>
          running.host.state().executions[index === 0 ? "one" : "two"]?.kind === "attempt-ended",
      );
      running.host.acceptInput(
        { id: index === 0 ? "two" : "three", text: "Continue", mode: "queue" },
        { managed: true },
      );
    }
    await until(() => f.spawner.calls.length === 3);
    expect(running.host.contextCoverage("claude", "different")).toBe(0);
    expect(running.host.state().executions.three?.kind).toBe("attempt-started");
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("a managed terminal source drains legacy queued input and preserves its original receipt", async () => {
  const f = fixture();
  const writer = createConversationHost(f.paths.dir, {
    now: Date.now,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  writer.enqueueInput({ id: "legacy", text: "Legacy queued prompt", mode: "queue" });
  const receipt = writer.transcript().inputs.find((entry) => entry.id === "legacy");
  writer.close();
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Did not attach");
  try {
    await until(() => f.spawner.calls.length === 1);
    f.procs[0]?.emit({ kind: "identity", sessionId: "mixed", authority: "harness-minted" });
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    await until(() => f.spawner.calls.length === 2);
    expect(running.host.state().executions.legacy?.kind).toBe("attempt-started");
    const delivered = running.host.transcript().inputs.filter((entry) => entry.id === "legacy");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ id: receipt?.id, seq: receipt?.seq, text: receipt?.text });
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});

test("a managed persistent worker closes its native session and releases presence after idle", async () => {
  const f = fixture();
  replaceSettings(f.paths.dir, "managed", 1, {
    harness: "claude",
    model: "selected",
    effort: "high",
    profile: "headless-session",
  });
  const controller = new AbortController();
  const runner: HarnessRunner = {
    ...f.runner,
    inspect: async (h, choice) => ({ ...(await f.runner.inspect(h, choice)), session: true }),
  };
  const worker = runManagedWorker(f.root, "managed", "one", {
    runner,
    presence: () => false,
    idleMs: 5,
    tickMs: 1,
    signal: controller.signal,
  });
  const proc = f.procs[0];
  if (!proc) throw new Error("Missing process");
  try {
    await until(() => f.spawner.calls.length === 1);
    proc.emit({
      kind: "session",
      sessionId: "idle-native",
      harness: "claude",
      hcn: SYNTHETIC_HCN_IDENTITY,
    });
    await until(() => proc.commands.some((command) => command.op === "send"));
    proc.emit({ kind: "disposition", id: "one", disposition: "started" });
    proc.emit({ kind: "turn", turnId: "hcn-idle", id: "one" });
    proc.emit({ kind: "identity", sessionId: "idle-native", authority: "harness-minted" });
    proc.emit({ kind: "done", cause: "clean", exitCode: null });
    await until(() => proc.commands.some((command) => command.op === "close"));
    proc.emit({ kind: "closed", exitCode: 0, cause: "closed" });
    proc.exit(0);
    await worker;
    const reopened = await openDrivenConversation({
      rootDir: f.root,
      conversationId: "managed",
      runner,
      presence: () => false,
    });
    expect(reopened.kind).toBe("running");
    if (reopened.kind === "running") {
      reopened.abort();
      await reopened.done;
    }
  } finally {
    controller.abort();
    proc.exit(0);
    await worker;
    f.close();
  }
});

test("a repaired startup failure can retry the original accepted input", async () => {
  const f = fixture();
  try {
    await expect(
      openDrivenConversation({
        rootDir: f.root,
        conversationId: "managed",
        managed: true,
        presence: () => false,
        get runner(): HarnessRunner {
          throw new Error("Synthetic missing harness executable");
        },
      }),
    ).rejects.toThrow("Synthetic missing harness executable");
    const writer = createConversationHost(f.paths.dir, {
      now: Date.now,
      presence: () => false,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(writer.state().executions.one).toMatchObject({
      kind: "held",
      hold: { actions: ["change-settings", "retry"] },
    });
    expect(
      writer.writeExecution({
        kind: "retry-authorized",
        inputId: "one",
        attempt: 0,
        actionId: "repaired",
        acknowledgeEffects: false,
      }).verdict,
    ).toBe("accepted");
    writer.close();
    const running = await openDrivenConversation({
      rootDir: f.root,
      conversationId: "managed",
      managed: true,
      runner: f.runner,
      presence: () => false,
    });
    if (running.kind !== "running") throw new Error("Did not attach");
    try {
      await until(() => f.spawner.calls.length === 1);
      expect(running.host.state().executions.one?.kind).toBe("attempt-started");
    } finally {
      running.abort();
      await running.done;
    }
  } finally {
    f.close();
  }
});

test("native context rejection preserves the input without automatic retry or replacement session", async () => {
  const f = fixture(true, true);
  const running = await openDrivenConversation({
    rootDir: f.root,
    conversationId: "managed",
    managed: true,
    runner: f.runner,
    presence: () => false,
  });
  if (running.kind !== "running") throw new Error("Worker did not start");
  try {
    await until(() => f.spawner.calls.length === 1);
    // Synthetic native failure sequence; no captured fixture is modified.
    f.procs[0]?.emit({
      kind: "identity",
      sessionId: "native-context-failure",
      authority: "harness-minted",
    });
    f.procs[0]?.emit({ kind: "error", text: "Context window exceeded" });
    f.procs[0]?.emit({ kind: "done", cause: "error", exitCode: 1 });
    f.procs[0]?.exit(1);
    await until(() => running.host.state().executions.one?.kind === "attempt-ended");
    expect(running.host.state().executions.one).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "failed-after-start" },
    });
    expect(running.host.transcript().inputs).toHaveLength(1);
    expect(running.host.state().harnessSessions.codex).toBe("native-context-failure");
    const execution = running.host.state().executions.one;
    if (!execution) throw new Error("Lost accepted input");
    expect(recoveryPolicy(execution)).toEqual({
      actions: ["continue-fresh"],
      acknowledgeEffects: true,
    });
    expect(running.host.contextCoverage("codex", "native-context-failure")).toBe(0);
    expect(f.spawner.calls).toHaveLength(1);
  } finally {
    running.abort();
    await running.done;
    f.close();
  }
});
