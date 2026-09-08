import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createRecoveryAvailability } from "../../src/server/recovery-availability.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

test("recovery keeps its TTL and interactive conversion while explaining its own version refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-recovery-compatibility-"));
  const { paths } = createConversationRecord(root, "recovery", { workingDirectory: root });
  replaceSettings(paths.dir, "recovery", 0, {
    harness: "codex",
    model: "model",
    effort: "medium",
    profile: "interactive",
  });
  const host = createConversationHost(paths.dir, {
    executorLease: () => false,
    now: () => 1,
    presence: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  let now = 0;
  let version = "1.1.0";
  let probes = 0;
  const unused = (): never => {
    throw new Error("Recovery cannot run a model");
  };
  const runner: HarnessRunner = {
    capabilities: unused,
    countContext: unused,
    openSession: unused,
    streamTurn: unused,
    inspect: async (_harness, choice) => {
      expect(choice?.runtime?.profile).toBe("headless-turn");
      probes++;
      return {
        name: "codex",
        session: false,
        verifiedAgainst: "1.0.0",
        runtime: {
          executable: { path: "/selected/codex", version },
          verifiedAgainst: "1.0.0",
          resume: { status: "supported", reason: null },
        },
      };
    },
  };
  const recovery = createRecoveryAvailability(
    () => runner,
    () => now,
  );
  try {
    const failed = await recovery(paths.dir, host.state());
    expect(failed.actions).toEqual([]);
    expect(failed.reason).toContain("1.1.0");
    expect(failed.reason).toContain("1.0.0");
    version = "1.0.0";
    now = 1499;
    expect(await recovery(paths.dir, host.state())).toEqual(failed);
    expect(probes).toBe(1);
    now = 1500;
    expect((await recovery(paths.dir, host.state())).actions).toEqual(["retry", "continue-fresh"]);
    expect(probes).toBe(2);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
