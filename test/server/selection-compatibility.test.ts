import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createHubSettings } from "../../src/server/hub-settings.js";
import { replaceLocation, replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

test("managed selection feedback shares runtime inspection while interactive preferences add none", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-selection-"));
  const { paths } = createConversationRecord(root, "selection");
  const choice = {
    harness: "codex" as const,
    model: "model",
    effort: "medium",
    profile: "headless-turn" as const,
  };
  replaceLocation(paths.dir, "selection", 0, root);
  replaceSettings(paths.dir, "selection", 0, choice);
  let runtimeChecks = 0;
  const unused = (): never => {
    throw new Error("Diagnostics cannot run a task");
  };
  const runner: HarnessRunner = {
    capabilities: unused,
    countContext: unused,
    openSession: unused,
    streamTurn: unused,
    inspect: async (_harness, selected) => {
      if (selected?.runtime) runtimeChecks++;
      return {
        name: "codex",
        session: true,
        verifiedAgainst: "1.0.0",
        vocabulary: { models: ["model"], efforts: ["medium"], extensible: false },
        ...(selected?.runtime
          ? {
              runtime: {
                executable: { path: "/selected/codex", version: "1.1.0" },
                verifiedAgainst: "1.0.0",
                resume: { status: "unknown" as const, reason: null },
              },
            }
          : {}),
      };
    },
  };
  const settings = createHubSettings(root, undefined, runner);
  try {
    await Promise.all([settings.project(paths.dir), settings.project(paths.dir)]);
    await new Promise((resolve) => setImmediate(resolve));
    const snapshots = await Promise.all([settings.project(paths.dir), settings.project(paths.dir)]);
    expect(snapshots[0].compatibility).toMatchObject([
      {
        code: "harness-version-unverified",
        harness: { name: "codex", detected: "1.1.0", verified: "1.0.0", path: "/selected/codex" },
      },
    ]);
    expect(snapshots[1].compatibility).toEqual(snapshots[0].compatibility);
    expect(runtimeChecks).toBe(1);
    await settings.project(paths.dir);
    expect(runtimeChecks).toBe(1);
    replaceSettings(paths.dir, "selection", 1, { ...choice, profile: "interactive" });
    expect((await settings.project(paths.dir)).compatibility).toEqual([]);
    expect(runtimeChecks).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed selection inspection produces safe feedback instead of forwarding raw process output", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-selection-failed-"));
  const { paths } = createConversationRecord(root, "failed", { workingDirectory: root });
  replaceSettings(paths.dir, "failed", 0, {
    harness: "codex",
    model: "selected",
    effort: "medium",
    profile: "headless-turn",
  });
  const unused = (): never => {
    throw new Error("unused");
  };
  const runner: HarnessRunner = {
    capabilities: unused,
    countContext: unused,
    openSession: unused,
    streamTurn: unused,
    inspect: async () => {
      throw new Error("synthetic-private-stderr\u001b[31m");
    },
  };
  try {
    const result = await createHubSettings(root, undefined, runner).project(paths.dir);
    expect(result.compatibility).toMatchObject([
      { code: "inspection-unavailable", scope: "selection" },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-stderr");
    expect(result.conversationSettings.error).toContain("inspection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pending selection preview does not hold record reads or replace a changed selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-selection-pending-"));
  const { paths } = createConversationRecord(root, "pending", { workingDirectory: root });
  const choice = {
    harness: "codex" as const,
    model: "selected",
    effort: "medium",
    profile: "headless-turn" as const,
  };
  replaceSettings(paths.dir, "pending", 0, choice);
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const unused = (): never => {
    throw new Error("No task dispatch");
  };
  let probes = 0;
  const runner: HarnessRunner = {
    capabilities: unused,
    countContext: unused,
    openSession: unused,
    streamTurn: unused,
    inspect: async (_harness, selection) => {
      if (selection?.runtime) {
        probes++;
        started.resolve();
        await release.promise;
        throw new Error("synthetic-private-stderr");
      }
      return {
        name: "codex",
        session: true,
        verifiedAgainst: "1.0.0",
        vocabulary: { models: ["selected"], efforts: ["medium"], extensible: false },
      };
    },
  };
  const settings = createHubSettings(root, undefined, runner);
  try {
    let returned = false;
    const pending = settings.project(paths.dir).then((value) => {
      returned = true;
      return value;
    });
    await started.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const readableBeforeRelease = returned;
    release.resolve();
    await pending;
    expect(readableBeforeRelease).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    const settled = await settings.project(paths.dir);
    expect(settled.compatibility).toMatchObject([
      { code: "inspection-unavailable", severity: "warning" },
    ]);
    expect(JSON.stringify(settled)).not.toContain("synthetic-private-stderr");
    replaceSettings(paths.dir, "pending", 1, { ...choice, profile: "interactive" });
    expect((await settings.project(paths.dir)).compatibility).toEqual([]);
    expect(probes).toBe(1);
  } finally {
    release.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings failures retain the harness boundary's structured refusal and diagnostic identity", async () => {
  const { selectionProblem } = await import("../../src/harness/compatibility.js");
  const { HarnessRefusal } = await import("../../src/harness/runner.js");
  const { resolveSettings } = await import("../../src/server/hub-settings.js");
  const choice = {
    harness: "codex" as const,
    model: "selected",
    effort: "medium",
    profile: "headless-turn" as const,
  };
  const diagnostic = selectionProblem(
    choice,
    undefined,
    "selection-unsupported",
    "HCN refused this selection (unsupported-option)",
  );
  const unused = (): never => {
    throw new Error("unused");
  };
  const runner: HarnessRunner = {
    capabilities: unused,
    countContext: unused,
    openSession: unused,
    streamTurn: unused,
    inspect: async () => {
      throw new HarnessRefusal("unsupported-option", diagnostic.message, undefined, diagnostic);
    },
  };
  let failure: unknown;
  try {
    await resolveSettings(choice, runner);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "E-HUB-03",
    diagnostic: { code: "selection-unsupported" },
  });
  expect((failure as Error).message).toContain("unsupported-option");
});
