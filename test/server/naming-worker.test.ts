import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner, StreamTurnOptions } from "../../src/harness/runner.js";
import { readRecordMetadata } from "../../src/store/record-identity.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a clean blank title remains invalid output eligible for its one repair attempt", async () => {
  const { runNamingJob } = await import("../../src/server/naming-worker.js");
  const root = mkdtempSync(join(tmpdir(), "lucid-title-blank-"));
  roots.push(root);
  const { paths } = createConversationRecord(root, "c");
  openConversation(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  }).enqueueInput({ id: "first", text: "Repair project search", mode: "queue" });
  let launches = 0;
  const runner: HarnessRunner = {
    inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "fake" }),
    countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("unused");
    },
    streamTurn: async function* (options) {
      launches++;
      if (launches === 2) expect(options.prompt).toContain("Your previous output was invalid");
      yield {
        kind: "message",
        role: "assistant",
        text: launches === 1 ? "  " : "Project search repair",
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  };
  const resolve = async () => ({
    harness: "claude" as const,
    model: "concrete-opus",
    effort: "high",
    profile: "headless-turn" as const,
  });
  await runNamingJob(paths.dir, "c", runner, resolve);
  expect(readRecordMetadata(paths.dir).titleGeneration).toMatchObject({
    status: "repair",
    attempts: 1,
  });
  await runNamingJob(paths.dir, "c", runner, resolve);
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Project search repair",
    titleGeneration: { status: "finished", attempts: 2 },
  });
});

test("worker defers unresolved settings then names separately without a working folder or native resume", async () => {
  const { runNamingJob } = await import("../../src/server/naming-worker.js");
  const root = mkdtempSync(join(tmpdir(), "lucid-title-worker-"));
  roots.push(root);
  const { paths } = createConversationRecord(root, "c");
  const host = openConversation(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  host.enqueueInput({ id: "first", text: "Improve search for projects", mode: "queue" });
  const launches: StreamTurnOptions[] = [];
  const inspections: unknown[] = [];
  const runner: HarnessRunner = {
    inspect: async (_h, choice) => {
      inspections.push(choice);
      return { name: "claude", session: true, verifiedAgainst: "fake" };
    },
    countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("Naming must not open the working session");
    },
    streamTurn: async function* (options) {
      launches.push(options);
      expect(readRecordMetadata(paths.dir).titleGeneration).toMatchObject({
        attempts: 1,
        status: "running",
      });
      yield { kind: "message", role: "assistant", text: "Project search improvements" };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  };
  await runNamingJob(paths.dir, "c", runner, async () => null);
  expect(launches).toHaveLength(0);
  expect(readRecordMetadata(paths.dir).titleGeneration).toMatchObject({
    status: "eligible",
    attempts: 0,
  });
  await runNamingJob(paths.dir, "c", runner, async () => ({
    harness: "claude",
    model: "concrete-opus",
    effort: "high",
    profile: "headless-turn",
  }));
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({
    harness: "claude",
    model: "concrete-opus",
    effort: "high",
    isolation: "tool-free",
  });
  expect(launches[0]?.resume).toBeUndefined();
  expect(launches[0]?.cwd).not.toBe(paths.dir);
  expect(inspections).toContainEqual(expect.objectContaining({ isolation: "tool-free" }));
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Project search improvements",
    titleOrigin: "generated",
    titleRevision: 2,
  });
  expect(host.transcript().events).toHaveLength(0);
  await runNamingJob(paths.dir, "c", runner, async () => null);
  expect(launches).toHaveLength(1);
});

test("unsupported isolation is recorded without consuming an attempt or launching", async () => {
  const { runNamingJob } = await import("../../src/server/naming-worker.js");
  const root = mkdtempSync(join(tmpdir(), "lucid-title-refuse-"));
  roots.push(root);
  const { paths } = createConversationRecord(root, "c");
  openConversation(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  }).enqueueInput({ id: "first", text: "Search issues", mode: "queue" });
  const runner: HarnessRunner = {
    inspect: async () => {
      throw new Error("Unsupported tool isolation");
    },
    countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("must not launch");
    },
    streamTurn: () => {
      throw new Error("must not launch");
    },
  };
  await runNamingJob(paths.dir, "c", runner, async () => ({
    harness: "codex",
    model: "gpt-6-astra",
    effort: "high",
    profile: "headless-turn",
  }));
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Search issues",
    titleGeneration: { status: "unavailable", attempts: 0, reason: "tool-isolation-unavailable" },
  });
  await runNamingJob(
    paths.dir,
    "c",
    {
      ...runner,
      inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "fake" }),
      streamTurn: async function* () {
        yield { kind: "message", role: "assistant", text: "Search repairs" };
        yield { kind: "done", cause: "clean", exitCode: 0 };
      },
    },
    async () => ({
      harness: "claude",
      model: "concrete-opus",
      effort: "high",
      profile: "headless-turn",
    }),
  );
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Search repairs",
    titleGeneration: { status: "finished", attempts: 1 },
  });
});

test("a failed naming operation keeps its fallback and cannot consume another attempt", async () => {
  const { runNamingJob } = await import("../../src/server/naming-worker.js");
  const root = mkdtempSync(join(tmpdir(), "lucid-title-failure-"));
  roots.push(root);
  const { paths } = createConversationRecord(root, "c");
  openConversation(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  }).enqueueInput({ id: "first", text: "Repair project search", mode: "queue" });
  let launches = 0;
  const runner: HarnessRunner = {
    inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "fake" }),
    countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("unused");
    },
    streamTurn: async function* () {
      launches++;
      yield { kind: "done", cause: "failed", exitCode: 1 };
    },
  };
  const resolve = async () => ({
    harness: "claude" as const,
    model: "concrete-opus",
    effort: "high",
    profile: "headless-turn" as const,
  });
  await runNamingJob(paths.dir, "c", runner, resolve);
  await runNamingJob(paths.dir, "c", runner, resolve);
  expect(launches).toBe(1);
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Repair project search",
    titleGeneration: { status: "failed", attempts: 1 },
  });
});
