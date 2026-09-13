import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedWorker } from "../../src/cli/managed-worker.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { ownerPresence } from "../../src/process-owner.js";
import type { NativeBinding } from "../../src/protocol/connection.js";
import { createConversationHost, viewConversation } from "../../src/store/conversation-host.js";
import { preferenceState } from "../../src/store/driver-preference.js";
import { presenceHeld } from "../../src/store/presence.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

function nativeFixture(
  target: Pick<NativeBinding, "harness" | "interface"> = {
    harness: "codex",
    interface: "codex-cli",
  },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-native-runtime-")));
  const record = createConversationRecord(root, "native", { workingDirectory: root });
  const binding: NativeBinding = {
    generation: randomUUID(),
    ...target,
    nativeSessionId: "native-author",
    owner: { executable: "/synthetic/codex", pid: 123, startedAt: "123:456" },
    registrationId: randomUUID(),
    workingDirectory: root,
  };
  const browser = {
    effort: "low",
    harness: "muse",
    model: "browser-model",
    profile: "headless-session",
  } as const;
  replaceSettings(record.paths.dir, "native", 0, browser);
  const writer = createConversationHost(record.paths.dir, {
    connectionAuthority: () => binding,
    executorLease: () => false,
    now: Date.now,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: () => true,
    presence: () => undefined,
  });
  expect(writer.writeConnection({ actionId: randomUUID(), binding, kind: "bound" }).verdict).toBe(
    "accepted",
  );
  expect(
    writer.acceptInput(
      { id: "feedback", mode: "queue", text: "Continue the same conversation." },
      { managed: true },
    ).verdict,
  ).toBe("accepted");
  writer.close();
  return {
    binding,
    browser,
    close: () => rmSync(root, { force: true, recursive: true }),
    record,
    root,
  };
}

test("the automatic worker resumes a departed Codex author with native settings and one notice", async () => {
  const f = nativeFixture();
  const { binding, browser, record, root } = f;
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const wire = createHcnRunner({
    bin: "/fake/hcn",
    spawn: (argv, options) => {
      const child = spawner.spawn(argv, options);
      // Synthetic HCN events exercise runtime ownership, not native acceptance.
      queueMicrotask(() => {
        proc.emit({
          authority: "harness-minted",
          kind: "identity",
          sessionId: binding.nativeSessionId,
        });
        proc.emit({ kind: "message", role: "assistant", text: "Same conversation resumed." });
        proc.emit({ cause: "clean", exitCode: 0, kind: "done" });
        proc.exit(0);
      });
      return child;
    },
  });
  const runner: HarnessRunner = {
    ...wire,
    inspect: async (harness) => {
      expect(harness).toBe("codex");
      return { name: "codex", nativeContextManagement: true, session: false };
    },
    inspectNativeContinuation: async (target) => {
      expect(target).toMatchObject({
        cwd: root,
        harness: "codex",
        resume: binding.nativeSessionId,
      });
      return {
        effort: "high",
        fingerprint: "a".repeat(64),
        model: "native-model",
        provider: "native-provider",
        status: "available",
      };
    },
  };
  try {
    await runManagedWorker(root, "native", "feedback", {
      idleMs: 0,
      ownerPresence: (owner) => (owner.pid === binding.owner.pid ? false : ownerPresence(owner)),
      runner,
      tickMs: 1,
    });
    expect(spawner.calls).toHaveLength(1);
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv).toContain("--native-approvals");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(binding.nativeSessionId);
    expect(argv).not.toContain("browser-model");
    const snapshot = viewConversation(record.paths.dir);
    expect(snapshot.state.executions.feedback).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "completed" },
      start: {
        driver: {
          effort: "high",
          harness: "codex",
          model: "native-model",
          provider: "native-provider",
        },
      },
    });
    expect(Object.values(snapshot.state.connection?.launches ?? {})).toEqual([
      expect.objectContaining({ kind: "settled" }),
    ]);
    expect(
      snapshot.transcript.events.filter(
        ({ event }) =>
          event.kind === "message" &&
          event.text ===
            "No interactive session detected. Resuming headlessly with session native-author.",
      ),
    ).toHaveLength(1);
    expect(preferenceState(record.paths.dir).preference).toMatchObject(browser);
    expect(presenceHeld(record.paths.dir)).toBe(false);
  } finally {
    proc.exit(0);
    f.close();
  }
});

test.each([true, undefined] as const)(
  "automatic continuation preserves saved feedback when native owner presence is %s",
  async (presence) => {
    const f = nativeFixture();
    let inspected = 0;
    let spawned = 0;
    const runner: HarnessRunner = {
      ...createHcnRunner({
        bin: "/fake/hcn",
        spawn: () => {
          spawned++;
          throw new Error("No native process may start");
        },
      }),
      inspectNativeContinuation: async () => {
        inspected++;
        return { reason: "unexpected-inspection", status: "unavailable" };
      },
    };
    const before = viewConversation(f.record.paths.dir).state.seq;
    try {
      await runManagedWorker(f.root, "native", "feedback", {
        ownerPresence: () => presence,
        runner,
      });
      expect(inspected).toBe(0);
      expect(spawned).toBe(0);
      const snapshot = viewConversation(f.record.paths.dir);
      expect(snapshot.state.seq).toBe(before);
      expect(snapshot.state.executions.feedback?.kind).toBe("requested");
      expect(presenceHeld(f.record.paths.dir)).toBe(false);
    } finally {
      f.close();
    }
  },
);

test.each([
  { harness: "codex", interface: "codex-desktop" },
  { harness: "pi", interface: "pi-cli" },
  { harness: "muse", interface: "muse-cli" },
  { harness: "claude", interface: "claude-cli" },
] as const)(
  "automatic continuation does not enable the unverified $interface lane",
  async (target) => {
    const f = nativeFixture(target);
    let calls = 0;
    const runner = createHcnRunner({
      bin: "/fake/hcn",
      spawn: () => {
        calls++;
        throw new Error("An unverified interface cannot launch");
      },
    });
    const before = viewConversation(f.record.paths.dir).state.seq;
    try {
      await runManagedWorker(f.root, "native", "feedback", { ownerPresence: () => false, runner });
      expect(calls).toBe(0);
      expect(viewConversation(f.record.paths.dir).state.seq).toBe(before);
      expect(presenceHeld(f.record.paths.dir)).toBe(false);
    } finally {
      f.close();
    }
  },
);

test("unavailable native settings hold the input without launching or repeatedly probing it", async () => {
  const f = nativeFixture();
  let probes = 0;
  let processes = 0;
  const runner: HarnessRunner = {
    ...createHcnRunner({
      bin: "/fake/hcn",
      spawn: () => {
        processes++;
        throw new Error("Unavailable settings cannot start a native process");
      },
    }),
    inspectNativeContinuation: async () => {
      probes++;
      return { reason: "operation-unavailable", status: "unavailable" };
    },
  };
  try {
    for (let request = 0; request < 2; request++) {
      await runManagedWorker(f.root, "native", "feedback", {
        ownerPresence: (owner) =>
          owner.pid === f.binding.owner.pid ? false : ownerPresence(owner),
        runner,
      });
    }
    const snapshot = viewConversation(f.record.paths.dir);
    expect(probes).toBe(1);
    expect(processes).toBe(0);
    expect(snapshot.state.executions.feedback).toMatchObject({
      hold: { actions: [], reason: expect.stringContaining("operation-unavailable") },
      kind: "held",
    });
    expect(Object.values(snapshot.state.connection?.launches ?? {})).toEqual([]);
    expect(preferenceState(f.record.paths.dir).preference).toMatchObject(f.browser);
    expect(presenceHeld(f.record.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});
