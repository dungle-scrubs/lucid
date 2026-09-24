import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdActivity, runManagedWorker } from "../../src/cli/managed-worker.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

test("holdActivity counts live inputs and lossless events only", () => {
  const transcript = {
    events: [
      { epoch: 1, event: { kind: "message", text: "hi" }, seq: 1, turnId: "t1" },
      { epoch: 1, event: { kind: "token", text: "frag" }, seq: 2, turnId: "t1" },
      { epoch: 1, event: { kind: "progress" }, seq: 3, turnId: "t1" },
    ],
    inputs: [
      { id: "a", mode: "queue", seq: 0, status: "queued", text: "work" },
      { id: "b", mode: "queue", seq: 4, status: "cancelled", text: "dropped" },
    ],
  } as never;
  // One live input plus one lossless message. Token and progress are
  // droppable; the cancelled input does not count.
  expect(holdActivity(transcript)).toBe(2);
});

function holdFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-hold-")));
  const { paths } = createConversationRecord(root, "managed", { workingDirectory: root });
  replaceSettings(paths.dir, "managed", 0, {
    effort: "high",
    harness: "claude",
    model: "selected",
    profile: "headless-turn",
  });
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
      runtime: {
        executable: { path: "/fake/harness", version: "verified" },
        resume: { status: "supported", reason: null },
      },
      session: false,
      verifiedAgainst: "verified",
    }),
    countContext: async (request) => ({
      executable: { path: "/fake/harness", version: "verified" },
      inputLimitTokens: 10000,
      method: "native-context-estimate",
      model: request.model ?? "selected",
      status: "available",
      totalTokens: 1000,
    }),
  };
  return { paths, procs, root, runner, spawner };
}

test("hold mode exits after the window with no new activity", async () => {
  const f = holdFixture();
  try {
    const worker = runManagedWorker(f.root, "managed", "one", {
      runner: f.runner,
      holdMs: 50,
      tickMs: 5,
    });
    for (let tick = 0; tick < 300 && f.spawner.calls.length === 0; tick++) await Bun.sleep(5);
    expect(f.spawner.calls.length).toBe(1);
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    await worker;
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("detachRequested ends the hold at the boundary", async () => {
  const f = holdFixture();
  try {
    let detach = false;
    const worker = runManagedWorker(f.root, "managed", "one", {
      runner: f.runner,
      detachRequested: () => detach,
      holdMs: 60_000,
      tickMs: 5,
    });
    for (let tick = 0; tick < 300 && f.spawner.calls.length === 0; tick++) await Bun.sleep(5);
    expect(f.spawner.calls.length).toBe(1);
    f.procs[0]?.emit({ kind: "done", cause: "clean", exitCode: 0 });
    f.procs[0]?.exit(0);
    detach = true;
    await worker;
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("detach writes holdRelease and the projection shows detaching then gone", async () => {
  const { requestDetach } = await import("../../src/cli/detach.js");
  const { readConnection } = await import("../../src/store/connection-view.js");
  const { acquirePresence } = await import("../../src/store/presence.js");
  const { openWriter } = await import("../../src/store/conversation-host.js");
  const { createConversationRecord } = await import("../../src/store/store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-detach-")));
  try {
    const { paths, secret } = createConversationRecord(root, "held", {
      workingDirectory: root,
    });
    const dir = paths.dir;
    const { readRecordMetadata } = await import("../../src/store/record-identity.js");
    const { atomicSidecar } = await import("../../src/store/atomic-file.js");
    const { pathsForDir } = await import("../../src/store/errors.js");
    const meta = readRecordMetadata(dir);
    atomicSidecar(pathsForDir(dir).metaPath, { ...meta, handoff: true });
    // A past attachment proves a hold existed: attach then detach so epoch
    // advances past zero before the durable release is requested.
    const { openConversation } = await import("../../src/store/conversation-host.js");
    const { attach } = await import("../protocol/helpers.js");
    const { encodeFrame } = await import("../../src/protocol/frames.js");
    const seeder = openConversation(dir, {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      const attached = seeder.handleFrame(
        encodeFrame(attach({ conversationId: "held", secret, profile: "headless-turn" })),
      );
      if (attached.verdict !== "accepted")
        throw new Error(`seed attach refused: ${attached.verdict}`);
      const left = seeder.handleFrame(
        JSON.stringify({ kind: "detach", epoch: 1, reason: "shutdown" }),
      );
      if (left.verdict !== "accepted") throw new Error(`seed detach refused: ${left.verdict}`);
    } finally {
      seeder.close();
    }
    const first = requestDetach(root, "held");
    expect(first.message).toContain("Detach requested");
    const repeat = requestDetach(root, "held");
    expect(repeat.message).toContain("already released");
    // Presence held: detaching.
    const presence = acquirePresence(dir, "held");
    try {
      const host = openWriter(dir);
      try {
        expect(host.state().holdRelease).not.toBeNull();
      } finally {
        host.close();
      }
      const detaching = readConnection(dir, { holdMs: 30 * 60_000 });
      expect(detaching.state).toBe("hold-detaching");
    } finally {
      presence.release();
    }
    // Presence released: gone (closed branch).
    const gone = readConnection(dir, { holdMs: 30 * 60_000 });
    expect(gone.state).toBe("closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold-connected shows the countdown while presence is held", async () => {
  const { readConnection } = await import("../../src/store/connection-view.js");
  const { acquirePresence } = await import("../../src/store/presence.js");
  const { openWriter } = await import("../../src/store/conversation-host.js");
  const { createConversationRecord } = await import("../../src/store/store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-holdconn-")));
  try {
    const { paths } = createConversationRecord(root, "held", { workingDirectory: root });
    const dir = paths.dir;
    const { readRecordMetadata } = await import("../../src/store/record-identity.js");
    const { atomicSidecar } = await import("../../src/store/atomic-file.js");
    const { pathsForDir } = await import("../../src/store/errors.js");
    const meta = readRecordMetadata(dir);
    atomicSidecar(pathsForDir(dir).metaPath, { ...meta, handoff: true });
    const host = openWriter(dir);
    try {
      host.acceptInput({ id: "task-1", text: "Review.", mode: "queue" }, { managed: true });
    } finally {
      host.close();
    }
    const presence = acquirePresence(dir, "held");
    try {
      const connected = readConnection(dir, { holdMs: 30 * 60_000 });
      expect(connected.state).toBe("hold-connected");
      expect(connected.message).toContain("minutes left");
    } finally {
      presence.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold-released repeats idempotently and conflicts on reuse", async () => {
  const { openWriter } = await import("../../src/store/conversation-host.js");
  const { createConversationRecord } = await import("../../src/store/store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-holdfact-")));
  try {
    const { paths } = createConversationRecord(root, "held", { workingDirectory: root });
    const dir = paths.dir;
    const { readRecordMetadata } = await import("../../src/store/record-identity.js");
    const { atomicSidecar } = await import("../../src/store/atomic-file.js");
    const { pathsForDir } = await import("../../src/store/errors.js");
    const meta = readRecordMetadata(dir);
    atomicSidecar(pathsForDir(dir).metaPath, { ...meta, handoff: true });
    const host = openWriter(dir);
    try {
      const actionId = crypto.randomUUID();
      expect(host.writeConnection({ actionId, kind: "hold-released" }).verdict).toBe("accepted");
      expect(host.writeConnection({ actionId, kind: "hold-released" }).verdict).toBe("accepted");
      expect(
        host.writeConnection({ actionId: crypto.randomUUID(), kind: "hold-released" }).verdict,
      ).toBe("refused");
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detach refuses on a record that never held a hold", async () => {
  const { requestDetach } = await import("../../src/cli/detach.js");
  const { createConversationRecord } = await import("../../src/store/store.js");
  const { HubError } = await import("../../src/protocol/hub-errors.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-detachref-")));
  try {
    createConversationRecord(root, "plain", { workingDirectory: root });
    let issue: unknown;
    try {
      requestDetach(root, "plain");
    } catch (cause) {
      issue = cause;
    }
    expect(issue).toBeInstanceOf(HubError);
    expect((issue as { message: string }).message).toContain("never held");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plain record with held presence is not labeled a handoff hold", async () => {
  const { readConnection } = await import("../../src/store/connection-view.js");
  const { acquirePresence } = await import("../../src/store/presence.js");
  const { createConversationRecord } = await import("../../src/store/store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-plainhold-")));
  try {
    const { paths } = createConversationRecord(root, "plain", { workingDirectory: root });
    const presence = acquirePresence(paths.dir, "plain");
    try {
      const status = readConnection(paths.dir, { holdMs: 30 * 60_000 });
      expect(status.state).not.toBe("hold-connected");
    } finally {
      presence.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("droppable events never extend the hold clock", () => {
  const transcript = {
    inputs: [{ status: "queued" }, { status: "cancelled" }],
    events: [
      { event: { kind: "token" } },
      { event: { kind: "progress" } },
      { event: { kind: "context" } },
      { event: { kind: "message" } },
      { event: { kind: "tool" } },
    ],
  };
  // One live input plus the two lossless events; the droppable kinds
  // (token, progress, context) and the cancelled input do not count.
  expect(holdActivity(transcript as never)).toBe(3);
});

test("detach maps through the subcommand seam", async () => {
  const { mapSubcommand } = await import("../../src/cli/mapping.js");
  const mapped = mapSubcommand(["detach", "abc123"]);
  expect(mapped.kind).toBe("detach");
  if (mapped.kind === "detach") expect(mapped.conversationId).toBe("abc123");
  const help = mapSubcommand(["detach"]);
  expect(help.kind).toBe("help");
});
