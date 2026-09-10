import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextCountOptions, HarnessRunner } from "../../src/harness/runner.js";
import { createManagedPreparation } from "../../src/modes/managed-preparation.js";
import { offerProjectedContext } from "../../src/store/context-offer.js";
import {
  type ConversationHost,
  createConversationHost,
} from "../../src/store/conversation-host.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

const driver = {
  harness: "claude",
  model: "selected",
  effort: "high",
  profile: "headless-turn",
} as const;
function setup(profile: "headless-turn" | "headless-session" = "headless-turn") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-managed-preparation-")));
  const record = createConversationRecord(root, "managed", { workingDirectory: root });
  let lease = true;
  const host = createConversationHost(record.paths.dir, {
    executorLease: () => lease,
    now: () => 1,
    presence: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  replaceSettings(record.paths.dir, "managed", 0, { ...driver, profile });
  host.acceptInput(
    { id: "request", text: "Update the document", mode: "queue" },
    { managed: true },
  );
  host.handleFrame(
    JSON.stringify({
      kind: "attach",
      conversationId: "managed",
      secret: record.secret,
      version: 1,
      harness: "claude",
      profile,
      capabilities: ["managed-input-v1"],
      attachmentOrigin: "automatic",
    }),
  );
  host.writeArtifact({
    artifactId: "doc",
    version: 1,
    author: "user",
    contentType: "text/plain",
    bytes: "Complete current document",
  });
  const counts: ContextCountOptions[] = [];
  const offeredPaths: string[] = [];
  const offerContext: typeof offerProjectedContext = (dir, context) => {
    const offer = offerProjectedContext(dir, context);
    offeredPaths.push(offer.path);
    return offer;
  };
  const runner: HarnessRunner = {
    inspect: async () => ({
      name: "claude",
      session: false,
      verifiedAgainst: "verified",
      runtime: {
        executable: { path: "/fake/harness", version: "verified" },
        resume: { status: "supported", reason: null },
      },
    }),
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: "selected",
        inputLimitTokens: 10000,
        totalTokens: 1000,
      };
    },
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("Preparation cannot launch the task");
    },
    streamTurn: () => {
      throw new Error("No summary needed");
    },
  };
  return {
    root,
    host,
    runner,
    counts,
    offeredPaths,
    dropLease: () => {
      lease = false;
    },
    offerContext,
    close: () => {
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const input = {
  inputId: "request",
  text: "Update the document",
  turnId: "turn-1",
  profile: "headless-turn",
  native: { kind: "fresh" },
} as const;

test("fresh work trusts HCN operation results despite differing version metadata", async () => {
  const f = setup();
  const runner: HarnessRunner = {
    ...f.runner,
    inspect: async () => ({
      name: "claude",
      session: false,
      verifiedAgainst: "1.0.0",
      runtime: {
        executable: { path: "/selected/claude", version: "1.2.0" },
        verifiedAgainst: "1.1.0",
        resume: { status: "unknown", reason: null },
      },
    }),
  };
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner,
    driver,
    cwd: f.root,
  });
  try {
    expect(
      (await preparation.prepare({ ...input, signal: new AbortController().signal })).kind,
    ).toBe("ready");
    expect(f.counts).toHaveLength(1);
  } finally {
    preparation.close();
    f.host.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("managed preparation records the counted context before task dispatch and owns its offered copy", async () => {
  const f = setup();
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner: f.runner,
    driver,
    cwd: f.root,
  });
  try {
    const result = await preparation.prepare({ ...input, signal: new AbortController().signal });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("held");
    expect(f.counts[0]?.prompt).toBe(result.prompt);
    expect(result.summary).toBeNull();
    expect(result.accounting?.model).toBe("selected");
    expect(result.prompt).toContain("Complete current document");
    expect(result.prompt).toContain("Update the document");
    expect(result.prompt).toContain("lucid-artifact");
    expect(result.prompt).not.toContain(f.host.dir);
    expect(f.host.state().executions.request).toMatchObject({
      kind: "attempt-started",
      attempt: 1,
      turnId: "turn-1",
      native: { kind: "fresh" },
      driver,
    });
    const path = preparation.offeredPath("turn-1");
    if (!path) throw new Error("The active turn has no offered context");
    expect(existsSync(path)).toBe(true);
    preparation.release("turn-1");
    expect(existsSync(path)).toBe(false);
  } finally {
    preparation.close();
    f.close();
  }
});

test("a settings change during accounting holds the original input without consuming an attempt", async () => {
  const f = setup();
  const count = f.runner.countContext;
  const runner = {
    ...f.runner,
    countContext: async (request: ContextCountOptions) => {
      replaceSettings(f.host.dir, "managed", 1, { ...driver, model: "changed" });
      return count(request);
    },
  };
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner,
    driver,
    cwd: f.root,
  });
  try {
    expect(await preparation.prepare({ ...input, signal: new AbortController().signal })).toEqual({
      kind: "held",
    });
    expect(f.host.state().executions.request).toMatchObject({
      kind: "held",
      attempt: 0,
      hold: { code: "E-HUB-06", actions: ["retry"] },
    });
    expect(preparation.offeredPath("turn-1")).toBeUndefined();
    for (const path of f.offeredPaths) expect(existsSync(path)).toBe(false);
  } finally {
    preparation.close();
    f.close();
  }
});

test("unknown context accounting persists an actionable hold without dispatch", async () => {
  const f = setup();
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async () => ({ status: "unavailable", reason: "unsupported-adapter" }),
  };
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner,
    driver,
    cwd: f.root,
  });
  try {
    expect(await preparation.prepare({ ...input, signal: new AbortController().signal })).toEqual({
      kind: "held",
    });
    expect(f.host.state().executions.request).toMatchObject({
      kind: "held",
      attempt: 0,
      hold: { code: "E-HUB-03", actions: ["change-settings"] },
    });
  } finally {
    preparation.close();
    f.close();
  }
});

test("cancellation during accounting consumes no attempt and removes the offered copy", async () => {
  const f = setup();
  const abort = new AbortController();
  const count = f.runner.countContext;
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async (request) => {
      abort.abort();
      return count(request);
    },
  };
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner,
    driver,
    cwd: f.root,
  });
  try {
    expect(await preparation.prepare({ ...input, signal: abort.signal })).toEqual({ kind: "held" });
    expect(f.host.state().executions.request).toMatchObject({ kind: "requested", attempt: 0 });
    expect(preparation.offeredPath("turn-1")).toBeUndefined();
    for (const path of f.offeredPaths) expect(existsSync(path)).toBe(false);
  } finally {
    preparation.close();
    f.close();
  }
});

test("an unverified native identity cannot become a fresh fallback", async () => {
  const f = setup();
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner: f.runner,
    driver,
    cwd: f.root,
  });
  try {
    expect(
      await preparation.prepare({
        ...input,
        native: { kind: "resume", sessionId: "unknown-native" },
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "held" });
    expect(f.counts).toHaveLength(0);
    expect(f.host.state().executions.request).toMatchObject({
      kind: "held",
      attempt: 0,
      hold: { code: "E-HUB-03" },
    });
  } finally {
    preparation.close();
    f.close();
  }
});

test("an unreadable recorded event becomes a context hold before any accounting", async () => {
  const f = setup();
  const preparation = createManagedPreparation({
    host: f.host,
    offerContext: f.offerContext,
    runner: f.runner,
    driver,
    cwd: f.root,
  });
  try {
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: f.host.state().epoch,
          n: 1,
          turnId: "prior",
          event: { kind: "future-evidence", text: "Uninterpreted evidence" },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(await preparation.prepare({ ...input, signal: new AbortController().signal })).toEqual({
      kind: "held",
    });
    expect(f.counts).toHaveLength(0);
    expect(f.host.state().executions.request).toMatchObject({
      kind: "held",
      attempt: 0,
      hold: { code: "E-HUB-06" },
    });
  } finally {
    preparation.close();
    f.close();
  }
});

test("a verified native session is retained, and explicit fresh recovery can replace it", async () => {
  for (const fresh of [false, true]) {
    const f = setup();
    const preparation = createManagedPreparation({
      host: f.host,
      runner: f.runner,
      driver,
      cwd: f.root,
      offerContext: f.offerContext,
    });
    try {
      expect(
        f.host.handleFrame(
          JSON.stringify({
            kind: "event",
            epoch: f.host.state().epoch,
            n: 1,
            turnId: "previous",
            event: { kind: "identity", sessionId: "native-a", authority: "harness-minted" },
          }),
        ).verdict,
      ).toBe("accepted");
      const request = {
        ...input,
        signal: new AbortController().signal,
        native: { kind: "resume" as const, sessionId: fresh ? "unverified" : "native-a" },
      };
      if (fresh) {
        expect(await preparation.prepare(request)).toEqual({ kind: "held" });
        expect(f.host.state().executions.request).toMatchObject({
          hold: { actions: ["continue-fresh", "change-settings"] },
        });
        expect(
          f.host.writeExecution({
            kind: "fresh-authorized",
            inputId: "request",
            attempt: 0,
            actionId: "fresh-1",
            acknowledgeEffects: false,
          }).verdict,
        ).toBe("accepted");
      }
      const ready = await preparation.prepare(request);
      expect(ready.kind).toBe("ready");
      if (ready.kind !== "ready") throw new Error("Preparation held");
      expect(ready.native).toEqual(
        fresh ? { kind: "fresh" } : { kind: "resume", sessionId: "native-a" },
      );
      expect(ready.prompt).toContain("only create or modify the Lucid artifact");
      expect(f.counts.at(-1)?.prompt).toBe(ready.prompt);
      expect(f.counts.at(-1)?.resume).toBe(fresh ? undefined : "native-a");
      expect(f.host.transcript().inputs.filter((entry) => entry.id === "request")).toHaveLength(1);
    } finally {
      preparation.close();
      f.close();
    }
  }
});

test("cleanup failure retains each owned copy for a later cleanup attempt", async () => {
  const f = setup();
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async () => ({ status: "unavailable", reason: "transport" }),
  };
  const preparation = createManagedPreparation({
    host: f.host,
    runner,
    driver,
    cwd: f.root,
    offerContext: (dir, context) => {
      const offer = f.offerContext(dir, context);
      let calls = 0;
      return {
        ...offer,
        close: () => {
          if (++calls === 1) throw new Error("synthetic cleanup failure");
          offer.close();
        },
      };
    },
  });
  try {
    for (const turnId of ["turn-1", "turn-2"]) {
      if (turnId === "turn-2")
        expect(
          f.host.writeExecution({
            kind: "retry-authorized",
            inputId: input.inputId,
            attempt: 0,
            actionId: "retry-cleanup",
            acknowledgeEffects: false,
          }).verdict,
        ).toBe("accepted");
      expect(
        await preparation.prepare({ ...input, turnId, signal: new AbortController().signal }),
      ).toEqual({ kind: "held" });
    }
    expect(f.offeredPaths).toHaveLength(2);
    for (const path of f.offeredPaths) expect(existsSync(path)).toBe(true);
    preparation.close();
    for (const path of f.offeredPaths) expect(existsSync(path)).toBe(false);
  } finally {
    preparation.close();
    f.close();
  }
});

test("summary provenance survives preparation while the full source remains available", async () => {
  const f = setup();
  const counted = f.runner.countContext;
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async (request) => {
      const result = await counted(request);
      if (result.status !== "available") return result;
      return {
        ...result,
        totalTokens:
          !request.isolation && request.prompt.includes("old-history-marker") ? 11000 : 1000,
      };
    },
    streamTurn: async function* (request) {
      expect(request.isolation).toBe("tool-free");
      expect(request.resume).toBeUndefined();
      yield {
        kind: "message",
        role: "assistant",
        text: "Derived source summary. Preserve the document constraints and unfinished work.",
      };
      yield { kind: "done", cause: "clean", exitCode: 0 };
    },
  };
  const preparation = createManagedPreparation({
    host: f.host,
    runner,
    driver,
    cwd: f.root,
    offerContext: f.offerContext,
  });
  try {
    for (let n = 1; n <= 12; n++)
      expect(
        f.host.handleFrame(
          JSON.stringify({
            kind: "event",
            epoch: f.host.state().epoch,
            n,
            turnId: "previous",
            event: {
              kind: "message",
              role: "assistant",
              text:
                n <= 8
                  ? `old-history-marker ${"older evidence ".repeat(70)}`
                  : `Recent context ${n}`,
            },
          }),
        ).verdict,
      ).toBe("accepted");
    const ready = await preparation.prepare({ ...input, signal: new AbortController().signal });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("Preparation held");
    expect(ready.summary?.model).toBe("selected");
    expect(ready.summary?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(ready.prompt).toContain("Derived source summary");
    expect(ready.prompt).not.toContain("old-history-marker");
    expect(f.offeredPaths).toHaveLength(1);
    expect(await Bun.file(join(f.offeredPaths[0] ?? "missing", "context.txt")).text()).toContain(
      "old-history-marker",
    );
  } finally {
    preparation.close();
    f.close();
  }
});

test.each([false, true])(
  "resume skips historical events covered by that native session, native management %s",
  async (nativeManagement) => {
    const f = setup();
    const preparation = createManagedPreparation({
      host: f.host,
      runner: {
        ...f.runner,
        inspect: async () => ({
          ...(await f.runner.inspect("claude")),
          ...(nativeManagement
            ? { nativeContextManagement: "native-session-auto-compaction" as const }
            : {}),
        }),
      },
      driver,
      cwd: f.root,
      offerContext: f.offerContext,
    });
    try {
      const event = (n: number, payload: Record<string, unknown>) =>
        expect(
          f.host.handleFrame(
            JSON.stringify({
              kind: "event",
              epoch: f.host.state().epoch,
              n,
              turnId: "previous",
              event: payload,
            }),
          ).verdict,
        ).toBe("accepted");
      event(1, { kind: "identity", sessionId: "native-a", authority: "harness-minted" });
      event(2, { kind: "future-evidence", text: "Already known in native history" });
      expect(
        f.host.offerConversationContext({
          harness: "claude",
          sessionId: "native-a",
          turnId: "previous",
          context: { digest: "a".repeat(64), from: 0, through: f.host.state().seq + 1 },
        }).verdict,
      ).toBe("accepted");
      event(3, { kind: "done", cause: "clean", exitCode: 0 });
      expect(f.host.confirmConversationContext("previous").verdict).toBe("accepted");
      const result = await preparation.prepare({
        ...input,
        native: { kind: "resume", sessionId: "native-a" },
        signal: new AbortController().signal,
      });
      expect(result.kind).toBe("ready");
      expect(f.counts).toHaveLength(nativeManagement ? 0 : 1);
      if (!nativeManagement) expect(f.counts[0]?.resume).toBe("native-a");
      if (result.kind === "ready")
        expect(result.native).toEqual({ kind: "resume", sessionId: "native-a" });
      if (result.kind === "ready") expect(result.prompt).not.toContain("future-evidence");
    } finally {
      preparation.close();
      f.close();
    }
  },
);

test("closing preparation cancels its pending accounting and removes the copy", async () => {
  const f = setup();
  let counting!: () => void;
  const entered = new Promise<void>((resolve) => {
    counting = resolve;
  });
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: (request) =>
      new Promise((resolve) => {
        counting();
        request.signal?.addEventListener(
          "abort",
          () => resolve({ status: "unavailable", reason: "cancelled" }),
          { once: true },
        );
      }),
  };
  const abort = new AbortController();
  const preparation = createManagedPreparation({
    host: f.host,
    runner,
    driver,
    cwd: f.root,
    offerContext: f.offerContext,
  });
  try {
    const pending = preparation.prepare({ ...input, signal: abort.signal });
    await entered;
    preparation.close();
    const result = await Promise.race([pending, Bun.sleep(100).then(() => "not cancelled")]);
    expect(result).toEqual({ kind: "held" });
    for (const path of f.offeredPaths) expect(existsSync(path)).toBe(false);
    expect(f.host.state().executions.request?.attempt).toBe(0);
  } finally {
    abort.abort();
    preparation.close();
    f.close();
  }
});

test("failed harness inspection is a settings hold, not a lost task", async () => {
  const f = setup();
  const runner: HarnessRunner = {
    ...f.runner,
    inspect: async () => {
      throw new Error("synthetic inspection failure");
    },
  };
  const preparation = createManagedPreparation({
    host: f.host,
    runner,
    driver,
    cwd: f.root,
    offerContext: f.offerContext,
  });
  try {
    expect(await preparation.prepare({ ...input, signal: new AbortController().signal })).toEqual({
      kind: "held",
    });
    expect(f.counts).toHaveLength(0);
    expect(f.host.state().executions.request).toMatchObject({
      kind: "held",
      attempt: 0,
      hold: { code: "E-HUB-03" },
    });
  } finally {
    preparation.close();
    f.close();
  }
});

test("a lost executor lease surfaces the refused hold write", async () => {
  const f = setup();
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async () => {
      f.dropLease();
      return { status: "unavailable", reason: "unsupported-adapter" };
    },
  };
  const preparation = createManagedPreparation({
    host: f.host,
    runner,
    driver,
    cwd: f.root,
    offerContext: f.offerContext,
  });
  try {
    expect(await preparation.prepare({ ...input, signal: new AbortController().signal })).toEqual({
      kind: "held",
      issue: "executor-required",
    });
    expect(f.host.state().executions.request).toMatchObject({ kind: "requested", attempt: 0 });
  } finally {
    preparation.close();
    f.close();
  }
});

test("duplicate turn reservations cannot replace an active offered copy", async () => {
  const f = setup();
  let counting!: () => void;
  let continueCount!: () => void;
  const entered = new Promise<void>((resolve) => {
    counting = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    continueCount = resolve;
  });
  const counted = f.runner.countContext;
  const runner: HarnessRunner = {
    ...f.runner,
    countContext: async (request) => {
      counting();
      await gate;
      return counted(request);
    },
  };
  const preparation = createManagedPreparation({
    host: f.host,
    runner,
    driver,
    cwd: f.root,
    offerContext: f.offerContext,
  });
  try {
    const pending = preparation.prepare({ ...input, signal: new AbortController().signal });
    await entered;
    const duplicate = { ...input, inputId: "other", signal: new AbortController().signal };
    expect(await preparation.prepare(duplicate)).toEqual({
      kind: "held",
      issue: "execution-ineligible",
    });
    continueCount();
    expect((await pending).kind).toBe("ready");
    expect(await preparation.prepare(duplicate)).toEqual({
      kind: "held",
      issue: "execution-ineligible",
    });
    expect(f.offeredPaths).toHaveLength(1);
    expect(preparation.offeredPath("turn-1")).toBe(f.offeredPaths[0]);
  } finally {
    continueCount();
    preparation.close();
    f.close();
  }
});

test("cancellation during the attempt append records that dispatch was not called", async () => {
  const f = setup();
  let preparation: ReturnType<typeof createManagedPreparation>;
  const host = {
    ...f.host,
    writePreparedExecution: (...args: Parameters<typeof f.host.writePreparedExecution>) => {
      const result = f.host.writePreparedExecution(...args);
      preparation.release("turn-1");
      return result;
    },
  };
  preparation = createManagedPreparation({
    host,
    runner: f.runner,
    driver,
    cwd: f.root,
    offerContext: f.offerContext,
  });
  try {
    expect(await preparation.prepare({ ...input, signal: new AbortController().signal })).toEqual({
      kind: "held",
    });
    expect(f.host.state().executions.request).toMatchObject({
      kind: "attempt-ended",
      attempt: 1,
      outcome: { kind: "pre-start-failed", failure: { evidence: "dispatch-not-called" } },
    });
    for (const path of f.offeredPaths) expect(existsSync(path)).toBe(false);
  } finally {
    preparation.close();
    f.close();
  }
});

test("managed comparison suppression survives automatic attachment and releases only on newer content or a new explicit intent", async () => {
  const f = setup();
  const { encodeAnnotationBatch } = await import("../../src/protocol/annotations.js");
  const { readContentSource } = await import("../../src/protocol/content-comparison.js");
  f.host.writeArtifact({
    artifactId: "doc",
    version: 2,
    author: "human",
    contentType: "text/html",
    bytes: "<p>Reviewed wording</p>",
  });
  const current = f.host.comparisonSnapshot("doc").artifact;
  if (!current) throw new Error("missing artifact");
  const passage = readContentSource(current.bytes, current.author).passages[0];
  if (!passage) throw new Error("missing passage");
  const text = encodeAnnotationBatch({
    artifactId: "doc",
    version: 2,
    comparison: { earlierVersion: 1, reviewedVersion: 2, reviewedHash: current.hash },
    notes: [
      {
        note: "Keep these words",
        spots: [
          {
            id: passage.id,
            author: passage.author,
            snippet: passage.text,
            selectors: passage.selectors,
            sourceVersion: 2,
            sourceHash: current.hash,
          },
        ],
      },
    ],
  });
  expect(
    f.host.acceptInput({ id: "comparison", text, mode: "queue" }, { managed: true }),
  ).toMatchObject({ verdict: "accepted" });
  let unavailable = true;
  const host = {
    ...f.host,
    captureDispatch: (...args: Parameters<ConversationHost["captureDispatch"]>) => {
      if (unavailable) throw new Error("synthetic unreadable");
      return f.host.captureDispatch(...args);
    },
  };
  let preparation = createManagedPreparation({ host, runner: f.runner, driver, cwd: f.root });
  const request = { ...input, inputId: "comparison", text, signal: new AbortController().signal };
  try {
    expect((await preparation.prepare(request)).kind).toBe("held");
    expect(f.host.state().executions.comparison).toMatchObject({
      kind: "held",
      hold: { code: "E-COMP-07" },
    });
    unavailable = false;
    preparation.close();
    preparation = createManagedPreparation({ host, runner: f.runner, driver, cwd: f.root });
    expect((await preparation.prepare(request)).kind).toBe("held");
    expect(f.counts).toHaveLength(0);
    f.host.writeArtifact({
      artifactId: "doc",
      version: 3,
      author: "human",
      contentType: "text/plain",
      bytes: "Current additions survive",
    });
    const ready = await preparation.prepare(request);
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("held");
    expect(ready.prompt).toContain("Dispatch version: 3");
    expect(ready.prompt).toContain("Current additions survive");
    expect(ready.prompt.match(/Current additions survive/g)).toHaveLength(1);
    expect(ready.prompt).not.toContain("set `replaces` to the `version` it names");
  } finally {
    preparation.close();
    f.host.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "Claude native context routing preserves imported history: %s",
  async (hasHistory) => {
    const f = setup();
    const runner: HarnessRunner = {
      ...f.runner,
      inspect: async () => ({
        ...(await f.runner.inspect("claude")),
        nativeContextManagement: "native-session-auto-compaction",
      }),
      countContext: async (request) => {
        f.counts.push(request);
        return { status: "unavailable", reason: "protocol" };
      },
    };
    const preparation = createManagedPreparation({
      host: f.host,
      runner,
      driver,
      cwd: f.root,
      offerContext: f.offerContext,
    });
    try {
      if (hasHistory)
        expect(
          f.host.handleFrame(
            JSON.stringify({
              kind: "event",
              epoch: f.host.state().epoch,
              n: 1,
              turnId: "previous",
              event: { kind: "message", role: "assistant", text: "Retain this imported history" },
            }),
          ).verdict,
        ).toBe("accepted");
      const result = await preparation.prepare({ ...input, signal: new AbortController().signal });
      expect(result.kind).toBe(hasHistory ? "held" : "ready");
      expect(f.counts).toHaveLength(hasHistory ? 1 : 0);
      if (hasHistory) {
        expect(f.counts[0]?.prompt).toContain("Retain this imported history");
        expect(f.host.state().executions.request).toMatchObject({
          kind: "held",
          attempt: 0,
          hold: { code: "E-HUB-06", actions: ["retry"] },
        });
      } else {
        if (result.kind !== "ready") throw new Error("Unexpected hold");
        expect(result.accounting).toBeNull();
        expect(result.summary).toBeNull();
        expect(result.prompt).toContain("Complete current document");
        expect(result.prompt).toContain("Update the document");
        expect(existsSync(preparation.offeredPath(input.turnId) ?? "")).toBe(true);
      }
    } finally {
      preparation.close();
      f.close();
    }
  },
);

test.each([
  ["headless-turn", "auto-compaction"],
  ["headless-session", "auto-compaction"],
  ["headless-turn", "native-session-auto-compaction"],
  ["headless-session", "native-session-auto-compaction"],
] as const)(
  "native management skips accounting only in the declared mode: %s %s",
  async (profile, management) => {
    const f = setup(profile);
    const selected = { ...driver, profile };
    const runner: HarnessRunner = {
      ...f.runner,
      inspect: async () => ({
        ...(await f.runner.inspect("claude")),
        nativeContextManagement: management,
      }),
      countContext: async (request) => {
        if (profile === "headless-turn") throw new Error("Native management must not probe");
        return f.runner.countContext(request);
      },
    };
    const preparation = createManagedPreparation({
      host: f.host,
      offerContext: f.offerContext,
      runner,
      driver: selected,
      cwd: f.root,
    });
    try {
      const result = await preparation.prepare({
        ...input,
        profile,
        signal: new AbortController().signal,
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("held");
      expect(result.accounting === null).toBe(profile === "headless-turn");
      expect(f.counts).toHaveLength(profile === "headless-turn" ? 0 : 1);
      expect(result.summary).toBeNull();
      expect(result.prompt).toContain("Complete current document");
      expect(result.prompt).toContain("Update the document");
      expect(result.prompt).toContain("lucid-artifact");
      expect(result.prompt).toContain("Do not change project files or implement code changes.");
      expect(f.host.state().executions.request).toMatchObject({
        kind: "attempt-started",
        attempt: 1,
      });
      const path = preparation.offeredPath(input.turnId);
      if (!path) throw new Error("Missing full context offer");
      expect(existsSync(path)).toBe(true);
      preparation.release(input.turnId);
      expect(existsSync(path)).toBe(false);
    } finally {
      preparation.close();
      f.close();
    }
  },
);

test.each([
  ["settings-changed", "auto-compaction"],
  ["cancelled", "auto-compaction"],
  ["settings-changed", "native-session-auto-compaction"],
  ["cancelled", "native-session-auto-compaction"],
] as const)(
  "native management retains the dispatch fence: %s %s",
  async (condition, management) => {
    const f = setup();
    const abort = new AbortController();
    const runner: HarnessRunner = {
      ...f.runner,
      inspect: async () => {
        const facts = await f.runner.inspect("claude");
        if (condition === "settings-changed")
          replaceSettings(f.host.dir, "managed", 1, { ...driver, model: "changed" });
        if (condition === "cancelled") abort.abort();
        return {
          ...facts,
          nativeContextManagement: management,
        };
      },
      countContext: async () => {
        throw new Error("Unexpected accounting");
      },
    };
    const preparation = createManagedPreparation({
      host: f.host,
      offerContext: f.offerContext,
      runner,
      driver,
      cwd: f.root,
    });
    try {
      expect((await preparation.prepare({ ...input, signal: abort.signal })).kind).toBe("held");
      expect(f.host.state().executions.request?.attempt).toBe(0);
      expect(f.host.transcript().inputs).toHaveLength(1);
      if (condition !== "cancelled")
        expect(f.host.state().executions.request).toMatchObject({
          kind: "held",
          hold: { code: "E-HUB-06" },
        });
      for (const path of f.offeredPaths) expect(existsSync(path)).toBe(false);
    } finally {
      preparation.close();
      f.close();
    }
  },
);

test.each(["unverified-adapter", "capacity"] as const)(
  "integrating native management retains an existing hold until Retry: %s",
  async (failure) => {
    const f = setup();
    let integrated = false;
    const runner: HarnessRunner = {
      ...f.runner,
      inspect: async () => ({
        ...(await f.runner.inspect("claude")),
        ...(integrated
          ? { nativeContextManagement: "native-session-auto-compaction" as const }
          : {}),
      }),
      countContext: async (request) => {
        const measured = await f.runner.countContext(request);
        return failure === "unverified-adapter"
          ? { status: "unavailable", reason: "unverified-adapter" }
          : {
              ...measured,
              status: "available",
              executable: { path: "/fake/harness" },
              method: "native-context-estimate",
              model: "selected",
              inputLimitTokens: 967000,
              totalTokens: 970000,
            };
      },
    };
    let preparation = createManagedPreparation({ host: f.host, runner, driver, cwd: f.root });
    const request = { ...input, signal: new AbortController().signal };
    try {
      expect((await preparation.prepare(request)).kind).toBe("held");
      expect(f.host.state().executions.request).toMatchObject({
        kind: "held",
        attempt: 0,
        hold: { code: failure === "capacity" ? "E-HUB-06" : "E-HUB-03" },
      });
      const before = f.counts.length;
      preparation.close();
      integrated = true;
      preparation = createManagedPreparation({ host: f.host, runner, driver, cwd: f.root });
      expect((await preparation.prepare(request)).kind).toBe("held");
      expect(f.counts).toHaveLength(before);
      expect(
        f.host.writeExecution({
          kind: "retry-authorized",
          inputId: "request",
          attempt: 0,
          actionId: "retry-integrated",
          acknowledgeEffects: false,
        }).verdict,
      ).toBe("accepted");
      const result = await preparation.prepare(request);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("Retry held");
      expect(result.accounting).toBeNull();
      expect(f.counts).toHaveLength(before);
      expect(f.host.state().executions.request).toMatchObject({
        kind: "attempt-started",
        attempt: 1,
        inputId: "request",
      });
      expect(f.host.transcript().inputs.map((entry) => entry.id)).toEqual(["request"]);
    } finally {
      preparation.close();
      f.close();
    }
  },
);

test.each(["queued-note", "failed-attempt", "held-input"] as const)(
  "full native sessions retain unconfirmed %s across Retry and later input",
  async (tail) => {
    const f = setup();
    let n = 0;
    const event = (value: Record<string, unknown>, turnId = "prior") =>
      expect(
        f.host.handleFrame(
          JSON.stringify({
            kind: "event",
            epoch: f.host.state().epoch,
            n: ++n,
            turnId,
            event: value,
          }),
        ).verdict,
      ).toBe("accepted");
    const runner: HarnessRunner = {
      ...f.runner,
      inspect: async () => ({
        ...(await f.runner.inspect("claude")),
        nativeContextManagement: "native-session-auto-compaction",
      }),
      countContext: async (request) => {
        f.counts.push(request);
        return {
          status: "available",
          executable: { path: "/fake/harness" },
          method: "native-context-estimate",
          model: "selected",
          inputLimitTokens: 967000,
          totalTokens: 970000,
        };
      },
    };
    const preparation = createManagedPreparation({ host: f.host, runner, driver, cwd: f.root });
    try {
      event({ kind: "identity", sessionId: "native-a", authority: "harness-minted" });
      expect(
        f.host.offerConversationContext({
          harness: "claude",
          sessionId: "native-a",
          turnId: "prior",
          context: { digest: "a".repeat(64), from: 0, through: f.host.state().seq + 1 },
        }).verdict,
      ).toBe("accepted");
      event({ kind: "done", cause: "clean", exitCode: 0 });
      expect(f.host.confirmConversationContext("prior").verdict).toBe("accepted");
      expect(
        f.host.acceptInput(
          { id: "tail", text: `Preserve ${tail} evidence`, mode: "queue" },
          { managed: true },
        ).verdict,
      ).toBe("accepted");
      if (tail === "held-input")
        expect(
          f.host.writeExecution({
            kind: "held",
            inputId: "tail",
            attempt: 0,
            hold: {
              code: "E-HUB-06",
              prerequisite: "capacity",
              reason: "Context does not fit",
              actions: ["retry"],
            },
          }).verdict,
        ).toBe("accepted");
      if (tail === "failed-attempt") {
        expect(
          f.host.writeExecution({
            kind: "attempt-started",
            inputId: "tail",
            attempt: 1,
            epoch: f.host.state().epoch,
            turnId: "failed",
            driver,
            native: { kind: "resume", sessionId: "native-a" },
            context: { digest: "b".repeat(64), from: 0, through: f.host.state().seq },
          }).verdict,
        ).toBe("accepted");
        event(
          { kind: "message", role: "assistant", text: "Partial output from the failed attempt" },
          "failed",
        );
        event({ kind: "done", cause: "error", exitCode: 1 }, "failed");
        expect(
          f.host.writeExecution({
            kind: "attempt-ended",
            inputId: "tail",
            attempt: 1,
            turnId: "failed",
            outcome: {
              kind: "failed-after-start",
              failure: { code: "native", evidence: "terminal-error", reason: "Synthetic failure" },
            },
          }).verdict,
        ).toBe("accepted");
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0)
          expect(
            f.host.writeExecution({
              kind: "retry-authorized",
              inputId: "request",
              attempt: 0,
              actionId: `retry-${attempt}`,
              acknowledgeEffects: false,
            }).verdict,
          ).toBe("accepted");
        expect(
          (
            await preparation.prepare({
              ...input,
              native: { kind: "resume", sessionId: "native-a" },
              turnId: `attempt-${attempt}`,
              signal: new AbortController().signal,
            })
          ).kind,
        ).toBe("held");
        expect(f.host.state().executions.request).toMatchObject({
          kind: "held",
          attempt: 0,
          hold: { code: "E-HUB-06", actions: ["retry"] },
        });
      }
      expect(f.counts[0]?.prompt).toContain(`Preserve ${tail} evidence`);
      expect(
        f.host.acceptInput({ id: "later", text: "Continue", mode: "queue" }, { managed: true })
          .verdict,
      ).toBe("accepted");
      expect(
        (
          await preparation.prepare({
            ...input,
            inputId: "later",
            text: "Continue",
            native: { kind: "resume", sessionId: "native-a" },
            turnId: "later-turn",
            signal: new AbortController().signal,
          })
        ).kind,
      ).toBe("held");
      expect(f.host.state().executions.later).toMatchObject({
        kind: "held",
        attempt: 0,
        hold: { code: "E-HUB-06" },
      });
      expect(f.host.transcript().inputs.map((entry) => entry.id)).toEqual([
        "request",
        "tail",
        "later",
      ]);
    } finally {
      preparation.close();
      f.close();
    }
  },
);
