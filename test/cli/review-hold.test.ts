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
    const { paths } = createConversationRecord(root, "held", { workingDirectory: root });
    const dir = paths.dir;
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
