import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { BACKGROUND_COMMAND } from "../../src/cli/invocation.js";
import { runManagedWorker } from "../../src/cli/managed-worker.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { startServer } from "../../src/server/server.js";
import { createConversationHost, viewSnapshot } from "../../src/store/conversation-host.js";
import { presenceHeld } from "../../src/store/presence.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

test("a background worker cannot fall through to server startup", async () => {
  const previous = env[BACKGROUND_COMMAND];
  let launches = 0;
  try {
    env[BACKGROUND_COMMAND] = "_managed-worker";
    await expect(
      startServer({
        port: 0,
        wakeNaming: () => launches++,
        managedLaunch: { request: () => launches++ },
      }),
    ).rejects.toThrow("A background worker cannot start a browser server");
    expect(launches).toBe(0);
  } finally {
    if (previous === undefined) delete env[BACKGROUND_COMMAND];
    else env[BACKGROUND_COMMAND] = previous;
  }
});

test("a failed server bind never launches pending work or starts a retry timer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-bind-worker-")));
  const { paths } = createConversationRecord(root, "worker", { workingDirectory: root });
  const host = createConversationHost(paths.dir, {
    now: Date.now,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  host.acceptInput({ id: "pending", text: "Pending task", mode: "queue" }, { managed: true });
  host.close();
  const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("test") });
  let launches = 0;
  try {
    await expect(
      startServer({
        rootDir: root,
        port: occupied.port,
        reconcileMs: 1,
        wakeNaming: () => launches++,
        managedLaunch: { request: () => launches++ },
      }),
    ).rejects.toThrow();
    await Bun.sleep(20);
    expect(launches).toBe(0);
  } finally {
    await occupied.stop(true);
    rmSync(root, { force: true, recursive: true });
  }
});

async function until(check: () => boolean): Promise<void> {
  for (let tick = 0; tick < 500 && !check(); tick++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

test("hub acceptance survives a missed launch and completes through reconciliation with no connected tab", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-hub-worker-")));
  const { paths } = createConversationRecord(root, "worker", { workingDirectory: root });
  replaceSettings(paths.dir, "worker", 0, {
    harness: "claude",
    model: "selected",
    effort: "high",
    profile: "headless-turn",
  });
  const prompts: string[] = [];
  const runner: HarnessRunner = {
    inspect: async () => ({
      name: "claude",
      session: false,
      verifiedAgainst: "test",
      runtime: {
        executable: { path: "/fake/harness", version: "test" },
        resume: { status: "supported", reason: null },
      },
    }),
    countContext: async (request) => ({
      status: "available",
      executable: { path: "/fake/harness", version: "test" },
      method: "native-context-estimate",
      model: request.model ?? "selected",
      inputLimitTokens: 10000,
      totalTokens: 1000,
    }),
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("unexpected session");
    },
    streamTurn: async function* (options) {
      prompts.push(options.prompt);
      expect(options.cwd).toBe(root);
      yield { kind: "identity", sessionId: "native", authority: "harness-minted" };
      yield { kind: "message", role: "assistant", text: "The worker answered" };
      yield { kind: "done", cause: "clean", exitCode: 0 };
    },
  };
  let requests = 0;
  const workers: Promise<void>[] = [];
  const server = await startServer({
    rootDir: root,
    port: 0,
    runner,
    reconcileMs: 20,
    managedLaunch: {
      request: (workerRoot, conversationId, inputId) => {
        if (++requests === 1) return; // Acceptance-before-launch crash boundary.
        workers.push(
          Bun.sleep(0).then(() =>
            runManagedWorker(workerRoot, conversationId, inputId, {
              runner,
              idleMs: 5,
              tickMs: 1,
              presence: () => false,
            }),
          ),
        );
      },
    },
  });
  try {
    const response = await fetch(`${server.url}/api/conversations/worker/input`, {
      method: "POST",
      headers: { "x-lucid-token": server.token, "content-type": "application/json" },
      body: JSON.stringify({ id: "accepted", text: "Answer from the independent worker" }),
    });
    expect(response.status).toBe(200);
    await until(() => viewSnapshot(paths.dir).state.executions.accepted?.kind === "attempt-ended");
    await until(() => !presenceHeld(paths.dir));
    expect(prompts).toHaveLength(1);
    expect(viewSnapshot(paths.dir).state.executions.accepted).toMatchObject({
      outcome: { kind: "completed" },
    });
    expect(viewSnapshot(paths.dir).transcript.inputs).toHaveLength(1);
    expect(requests).toBeGreaterThan(1);
  } finally {
    await server.close();
    await Promise.all(workers);
    rmSync(root, { recursive: true, force: true });
  }
});
