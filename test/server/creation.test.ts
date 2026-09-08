import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { startServer } from "../../src/server/server.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function rig() {
  const home = mkdtempSync(join(tmpdir(), "lucid-create-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "records");
  const configDir = join(home, ".config/lucid");
  mkdirSync(root);
  mkdirSync(configDir, { recursive: true });
  let launches = 0;
  const runner: HarnessRunner = {
    inspect: async (harness) => ({
      name: harness,
      session: harness === "claude",
      verifiedAgainst: "fake",
      vocabulary: {
        models: harness === "claude" ? ["concrete-opus", "concrete-sonnet"] : ["other-model"],
        aliases: { opus: "concrete-opus" },
        efforts: ["medium", "high"],
        extensible: false,
      },
    }),
    countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
    capabilities: async () => ({
      confidence: "high",
      images: false,
      session: true,
      source: "curated",
      streaming: "none",
      vision: false,
    }),
    openSession: async () => {
      launches++;
      throw new Error("must not launch");
    },
    streamTurn: async function* () {
      launches++;
      yield { kind: "done", cause: "failed", exitCode: 1 };
    },
  };
  const server = await startServer({
    rootDir: root,
    port: 0,
    configLocation: { home, xdgConfigHome: "" },
    runner,
  });
  cleanups.push(server.close);
  const request = (path: string, body?: unknown) =>
    fetch(`${server.url}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-lucid-token": server.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    home,
    root,
    runner,
    request,
    launches: () => launches,
    config: (text: string) => writeFileSync(join(configDir, "config.toml"), text),
  };
}

test("creation saves concrete defaults; reload and later defaults leave the first conversation unchanged", async () => {
  const r = await rig();
  const created = await r.request("conversations", {
    creationId: "first",
    workingDirectory: r.home,
  });
  expect(created.status).toBe(201);
  const first = await created.json();
  const opened = await r.request(`conversations/${first.conversationId}`).then((r) => r.json());
  expect(opened.driverPreference).toMatchObject({
    model: "concrete-opus",
    effort: "high",
    profile: "headless-turn",
    revision: 1,
  });
  expect(opened.driver).toEqual({});
  r.config('version = 1\n[defaults]\nmodel = "concrete-sonnet"\neffort = "medium"');
  const second = await r
    .request("conversations", { creationId: "second", workingDirectory: r.home })
    .then((r) => r.json());
  expect(second.conversationId).not.toBe(first.conversationId);
  expect(
    (await r.request(`conversations/${second.conversationId}`).then((r) => r.json()))
      .driverPreference.model,
  ).toBe("concrete-sonnet");
  expect(
    (await r.request(`conversations/${first.conversationId}`).then((r) => r.json()))
      .driverPreference.model,
  ).toBe("concrete-opus");
  expect(r.launches()).toBe(0);
  expect(readFileSync(join(r.root, first.conversationId, "log.ndjson"), "utf8")).toBe("");
});

test("concurrent and cold retries return one published record before reading changed defaults", async () => {
  const r = await rig();
  const body = { creationId: "retry", workingDirectory: r.home };
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => r.request("conversations", body).then((r) => r.json())),
  );
  expect(new Set(replies.map((r) => r.conversationId)).size).toBe(1);
  r.config("invalid = =");
  const retry = await r.request("conversations", body);
  expect(retry.status).toBe(201);
  expect((await retry.json()).conversationId).toBe(replies[0].conversationId);
  const collision = await r.request("conversations", { ...body, workingDirectory: r.root });
  expect(collision.status).toBe(409);
  expect((await collision.json()).error).toBe("E-HUB-02");
});

test("settings replace a complete bundle at the expected revision and effort preserves the concrete model", async () => {
  const r = await rig();
  const { conversationId } = await r
    .request("conversations", { creationId: "settings", workingDirectory: r.home })
    .then((r) => r.json());
  const route = `conversations/${conversationId}/driver`;
  const choice = {
    harness: "claude",
    model: "concrete-opus",
    effort: "medium",
    profile: "headless-turn",
    expectedRevision: 1,
  };
  const changed = await r.request(route, choice);
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({
    harness: "claude",
    model: "concrete-opus",
    effort: "medium",
    profile: "headless-turn",
    revision: 2,
  });
  expect((await r.request(route, { ...choice, effort: "high" })).status).toBe(409);
  expect(
    (await r.request(route, { harness: "claude", effort: "high", expectedRevision: 2 })).status,
  ).toBe(400);
  const opened = await r.request(`conversations/${conversationId}`).then((r) => r.json());
  expect(opened.driverPreference).toMatchObject({
    model: "concrete-opus",
    effort: "medium",
    revision: 2,
  });
  expect(opened.driver).toEqual({});
  expect(r.launches()).toBe(0);
});

test("legacy settings complete compatibly in memory and location changes preserve unknown metadata", async () => {
  const r = await rig();
  const { createConversationRecord } = await import("../../src/store/store.js");
  const record = createConversationRecord(r.root, "legacy");
  writeFileSync(
    record.paths.driverPath,
    JSON.stringify({ v: 1, harness: "codex", model: "other-model" }),
  );
  writeFileSync(
    record.paths.metaPath,
    JSON.stringify({ v: 1, conversationId: "legacy", futureField: "keep" }),
  );
  const before = readFileSync(record.paths.driverPath, "utf8");
  const opened = await r.request("conversations/legacy").then((r) => r.json());
  expect(opened.conversationSettings.selected).toMatchObject({
    harness: "codex",
    model: "other-model",
    effort: "high",
    profile: "headless-turn",
  });
  expect(opened.location.status).toBe("unknown");
  expect(readFileSync(record.paths.driverPath, "utf8")).toBe(before);
  expect(
    (
      await r.request("conversations/legacy/location", {
        workingDirectory: r.home,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(200);
  const recovered = await r.request("conversations/legacy").then((r) => r.json());
  expect(recovered.location.status).toBe("available");
  expect(JSON.parse(readFileSync(record.paths.metaPath, "utf8")).futureField).toBe("keep");
  expect(
    (
      await r.request("conversations/legacy/location", {
        workingDirectory: r.root,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(409);
  writeFileSync(record.paths.driverPath, "broken");
  const damaged = await r.request("conversations/legacy").then((r) => r.json());
  expect(damaged.conversationSettings.error).toContain("settings");
  expect(damaged.conversationSettings.selected).toBeNull();
  expect(r.launches()).toBe(0);
});

test("defaults errors stay visible and changing the configured root cannot retarget a running hub", async () => {
  const r = await rig();
  r.config('version = 1\nrecords_dir = "/different-root"');
  const defaults = await r.request("defaults");
  expect(defaults.status).toBe(200);
  expect(await defaults.json()).toMatchObject({ restartRequired: false, rootPinned: true });
  const created = await r
    .request("conversations", { creationId: "fixed-root", workingDirectory: r.home })
    .then((r) => r.json());
  expect((await r.request(`conversations/${created.conversationId}`)).status).toBe(200);
  r.config('version = 1\n[defaults]\nharness = "codex"');
  expect(await r.request("defaults").then((r) => r.json())).toMatchObject({
    selected: null,
    error: expect.stringContaining("Model"),
  });
  expect(
    (
      await r.request("conversations", {
        creationId: "bad",
        workingDirectory: r.home,
        settings: { model: "unavailable-model" },
      })
    ).status,
  ).toBe(400);
  expect((await r.request(`conversations/${created.conversationId}`)).status).toBe(200);
});

test("first submission saves compatible legacy settings while keeping an unknown folder recoverable", async () => {
  const r = await rig();
  const { createConversationRecord } = await import("../../src/store/store.js");
  const record = createConversationRecord(r.root, "legacy-send");
  writeFileSync(
    record.paths.driverPath,
    JSON.stringify({ v: 1, harness: "codex", model: "other-model" }),
  );
  const response = await r.request("conversations/legacy-send/input", {
    text: "Please continue this work",
  });
  expect(response.status).toBe(200);
  const opened = await r.request("conversations/legacy-send").then((r) => r.json());
  expect(opened.driverPreference).toMatchObject({
    model: "other-model",
    effort: "high",
    profile: "headless-turn",
    revision: 1,
  });
  expect(opened.location.status).toBe("unknown");
  expect(
    opened.lines.some((line: { text?: string }) => line.text?.includes("Please continue")),
  ).toBe(true);
  expect(r.launches()).toBe(0);
});

test("an accepted receipt is returned before legacy driver inspection or preference completion", async () => {
  const r = await rig();
  const { createConversationRecord } = await import("../../src/store/store.js");
  const { createConversationHost } = await import("../../src/store/conversation-host.js");
  const record = createConversationRecord(r.root, "retry-legacy");
  const host = createConversationHost(record.paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  const input = {
    id: "same-request",
    mode: "queue" as const,
    text: "Preserve this accepted request",
  };
  const accepted = host.acceptInput(input);
  host.close();
  if (accepted.verdict !== "accepted") throw new Error("acceptance failed");
  let inspected = 0;
  r.runner.inspect = async () => {
    inspected++;
    throw new Error("driver unavailable");
  };
  const reply = await r.request("conversations/retry-legacy/input", {
    id: input.id,
    text: input.text,
  });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ ...accepted.receipt, verdict: "accepted" });
  expect(inspected).toBe(0);
});

test("a created headless-turn choice is retained when the terminal explicitly opens its driver", async () => {
  const r = await rig();
  const created = await r
    .request("conversations", { creationId: "mode", workingDirectory: r.home })
    .then((r) => r.json());
  const { openDrivenConversation } = await import("../../src/cli/runtime.js");
  const running = await openDrivenConversation({
    rootDir: r.root,
    conversationId: created.conversationId,
    runner: r.runner,
  });
  if (running.kind !== "running") throw new Error("Expected an available driver");
  try {
    expect(running.profile).toBe("headless-turn");
  } finally {
    running.abort();
    await running.done;
  }
});

test("a settings save during legacy projection wins without rejecting the submitted prompt", async () => {
  const r = await rig();
  const { createConversationRecord } = await import("../../src/store/store.js");
  const { replaceSettings } = await import("../../src/store/settings.js");
  const record = createConversationRecord(r.root, "racing-send");
  const inspect = r.runner.inspect;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  r.runner.inspect = async (harness, choice) => {
    entered.resolve();
    await resume.promise;
    return inspect(harness, choice);
  };
  const pending = r.request("conversations/racing-send/input", { text: "Keep this prompt" });
  await entered.promise;
  replaceSettings(record.paths.dir, "racing-send", 0, {
    harness: "claude",
    model: "concrete-sonnet",
    effort: "medium",
    profile: "headless-turn",
  });
  resume.resolve();
  expect((await pending).status).toBe(200);
  expect(JSON.parse(readFileSync(record.paths.driverPath, "utf8"))).toMatchObject({
    model: "concrete-sonnet",
    revision: 1,
  });
  expect(readFileSync(record.paths.logPath, "utf8")).toContain("Keep this prompt");
});

test("a full input queue leaves legacy preferences unchanged", async () => {
  const r = await rig();
  const { INPUT_QUEUE_MAX } = await import("../../src/protocol/index.js");
  const { createConversationRecord } = await import("../../src/store/store.js");
  const record = createConversationRecord(r.root, "full-queue");
  const { createConversationHost } = await import("../../src/store/conversation-host.js");
  const host = createConversationHost(record.paths.dir, {
    now: () => 1000,
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  expect(
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "full-queue",
        profile: "headless-session",
        harness: "claude",
        secret: record.secret,
        version: 1,
      }),
    ).verdict,
  ).toBe("accepted");
  for (let i = 0; i < INPUT_QUEUE_MAX; i++) {
    expect(host.enqueueInput({ id: `fill-${i}`, text: `Prompt ${i}`, mode: "queue" }).verdict).toBe(
      "accepted",
    );
    expect(
      host.handleFrame(
        JSON.stringify({ kind: "disposition", epoch: 1, inputId: `fill-${i}`, outcome: "applied" }),
      ).verdict,
    ).toBe("accepted");
  }
  host.close();
  const legacy = JSON.stringify({ v: 1, harness: "claude", model: "concrete-opus" });
  writeFileSync(record.paths.driverPath, legacy);
  expect(
    (await r.request("conversations/full-queue/input", { text: "Refuse this prompt" })).status,
  ).toBe(429);
  expect(readFileSync(record.paths.driverPath, "utf8")).toBe(legacy);
  expect(readFileSync(record.paths.logPath, "utf8")).not.toContain("Refuse this prompt");
});

test("complete explicit choices can repair invalid defaults without silently replacing them", async () => {
  const r = await rig();
  r.config("invalid = =");
  expect((await r.request("defaults").then((r) => r.json())).error).toContain("Invalid TOML");
  expect(
    (await r.request("conversations", { creationId: "invalid-config", workingDirectory: r.home }))
      .status,
  ).toBe(400);
  expect(
    (
      await r.request("conversations", {
        creationId: "explicit",
        workingDirectory: r.home,
        settings: {
          harness: "claude",
          model: "concrete-opus",
          effort: "high",
          profile: "headless-turn",
        },
      })
    ).status,
  ).toBe(201);
});

test("malformed settings refuse an explicit driver start and release its presence lock", async () => {
  const r = await rig();
  const { createConversationRecord } = await import("../../src/store/store.js");
  const { openDrivenConversation } = await import("../../src/cli/runtime.js");
  const { presenceHeld } = await import("../../src/store/presence.js");
  const record = createConversationRecord(r.root, "damaged-start");
  writeFileSync(record.paths.driverPath, "broken");
  await expect(
    openDrivenConversation({ rootDir: r.root, conversationId: "damaged-start", runner: r.runner }),
  ).rejects.toThrow("Saved settings");
  expect(presenceHeld(record.paths.dir)).toBe(false);
  expect(r.launches()).toBe(0);
});

test("an unavailable record root keeps creation retryable with the same request", async () => {
  const r = await rig();
  const body = { creationId: "root-retry", workingDirectory: r.home };
  rmSync(r.root, { recursive: true });
  writeFileSync(r.root, "not a directory");
  const failed = await r.request("conversations", body);
  expect(failed.status).toBe(503);
  expect((await failed.json()).error).toBe("E-HUB-01");
  rmSync(r.root);
  mkdirSync(r.root);
  const recovered = await r.request("conversations", body);
  expect(recovered.status).toBe(201);
  const id = (await recovered.json()).conversationId;
  expect((await r.request("conversations", body).then((r) => r.json())).conversationId).toBe(id);
});

test("hub title writes validate text and use revision conflicts without launching a model", async () => {
  const r = await rig();
  const created = await (
    await r.request("conversations", { creationId: "title-create", workingDirectory: r.home })
  ).json();
  const path = `conversations/${created.conversationId}/title`;
  const malformed = await r.request(path, []);
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({
    error: "E-HUB-08",
    reason: expect.any(String),
    actions: ["Edit title"],
  });
  const rename = await r.request(path, { expectedRevision: 0, title: "  Search   repairs " });
  expect(rename.status).toBe(200);
  expect(await rename.json()).toMatchObject({
    title: "Search repairs",
    titleRevision: 1,
    titleOrigin: "manual",
  });
  expect((await r.request(path, { expectedRevision: 0, title: "Late title" })).status).toBe(409);
  expect(
    (
      await r.request(path, {
        expectedRevision: 1,
        title: "one two three four five six seven eight",
      })
    ).status,
  ).toBe(400);
  const page = await (await r.request("conversations")).json();
  expect(page.conversations[0]).toMatchObject({
    title: "Search repairs",
    titleRevision: 1,
    titleOrigin: "manual",
  });
  expect(r.launches()).toBe(0);
});
