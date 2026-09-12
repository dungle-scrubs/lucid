import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createManagedExecution } from "../../src/modes/managed-execution.js";
import type { ApprovalDecision } from "../../src/protocol/native-approvals.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

async function setup(resume?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-managed-outcomes-")));
  const record = createConversationRecord(root, "outcomes", { workingDirectory: root });
  const driver = {
    harness: "claude",
    model: "selected",
    effort: "high",
    profile: "headless-turn",
  } as const;
  replaceSettings(record.paths.dir, "outcomes", 0, driver);
  let lease = true;
  const host = createConversationHost(record.paths.dir, {
    executorLease: () => lease,
    now: () => 1,
    presence: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  host.acceptInput(
    { id: "input", text: "Update this workspace", mode: "queue" },
    { managed: true },
  );
  host.handleFrame(
    JSON.stringify({
      kind: "attach",
      conversationId: "outcomes",
      secret: record.secret,
      version: 1,
      harness: "claude",
      profile: "headless-turn",
      capabilities: ["managed-input-v1"],
      attachmentOrigin: "automatic",
    }),
  );
  if (resume)
    expect(
      host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "previous",
          event: { kind: "identity", sessionId: resume, authority: "harness-minted" },
        }),
      ).verdict,
    ).toBe("accepted");
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
    countContext: async () => ({
      status: "available",
      executable: { path: "/fake/harness", version: "verified" },
      method: "native-context-estimate",
      model: "selected",
      inputLimitTokens: 10000,
      totalTokens: 1000,
    }),
    capabilities: async () => {
      throw new Error("unused");
    },
    openSession: async () => {
      throw new Error("unused");
    },
    streamTurn: () => {
      throw new Error("unused");
    },
  };
  const execution = createManagedExecution({ cwd: root, driver, host, runner });
  const prepared = await execution.prepare({
    inputId: "input",
    text: "Update this workspace",
    turnId: "turn",
    profile: "headless-turn",
    native: resume ? { kind: "resume", sessionId: resume } : { kind: "fresh" },
    signal: new AbortController().signal,
  });
  expect(prepared.kind).toBe("ready");
  const path = execution.offeredPath("turn");
  if (!path) throw new Error("Missing context copy");
  let n = resume ? 1 : 0;
  return {
    host,
    execution,
    path,
    event: (event: Readonly<Record<string, unknown>>) => {
      expect(
        execution.sendFrame({ kind: "event", epoch: 1, n: ++n, turnId: "turn", event }).verdict,
      ).toBe("accepted");
    },
    dropLease: () => {
      lease = false;
    },
    close: () => {
      execution.close();
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a completed managed turn confirms coverage and settles once after its stream drains", async () => {
  const f = await setup();
  try {
    f.event({ kind: "identity", sessionId: "native", authority: "harness-minted" });
    f.event({ kind: "message", role: "assistant", text: "Workspace updated" });
    f.event({ kind: "done", cause: "clean", exitCode: 0 });
    const terminalSeq = f.host.state().completedTurns.turn;
    expect(f.host.contextCoverage("claude", "native")).toBe(0);
    expect(existsSync(f.path)).toBe(true);
    f.execution.turnSettled("turn");
    expect(f.host.state().executions.input).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "completed", terminalSeq },
    });
    expect(f.host.contextCoverage("claude", "native")).toBe((terminalSeq ?? 0) + 1);
    expect(existsSync(f.path)).toBe(false);
    const seq = f.host.state().seq;
    f.execution.turnSettled("turn");
    f.execution.close();
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.transcript().inputs).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("one managed attempt owns its approval channel until cleanup, with no replacement channel", async () => {
  const f = await setup("native");
  const requestId = randomUUID();
  const decision = { id: randomUUID(), requestId, choiceId: "deny" };
  const writes: ApprovalDecision[] = [];
  let cancelled = false;
  const channel = {
    alive: () => !cancelled,
    answer: (answer: ApprovalDecision) => {
      writes.push(answer);
    },
    cancel: () => {
      cancelled = true;
    },
  };
  try {
    const approvals = f.execution.connectApprovals("turn", channel);
    approvals.event({
      v: 1,
      kind: "approval-request",
      requestId,
      sessionId: "native",
      turnId: "native-turn",
      category: "command",
      details: "Synthetic command requiring a decision",
      choices: [{ id: "deny", label: "Deny", scope: "deny" }],
    });
    expect(f.host.decideApproval(decision, () => true).verdict).toBe("accepted");
    expect(writes).toEqual([]);
    f.execution.recordChanged();
    f.execution.recordChanged();
    expect(writes).toEqual([decision]);
    let replacementCancelled = false;
    expect(() =>
      f.execution.connectApprovals("turn", {
        ...channel,
        cancel: () => {
          replacementCancelled = true;
        },
      }),
    ).toThrow();
    expect(replacementCancelled).toBe(true);
    expect(cancelled).toBe(false);
    cancelled = true;
    approvals.closed();
    f.execution.turnSettled("turn");
    expect(f.host.state().approvals[requestId]?.status).toBe("unavailable");
    f.execution.recordChanged();
    expect(writes).toEqual([decision]);
  } finally {
    f.close();
  }
});

test.each(["rejected", "failed", "lost", "partial-rejected", "approval-rejected"] as const)(
  "managed %s outcome keeps context unconfirmed and preserves the input",
  async (kind) => {
    const f = await setup(kind === "approval-rejected" ? "native" : undefined);
    try {
      f.event({ kind: "identity", sessionId: "native", authority: "harness-minted" });
      if (kind === "partial-rejected") f.event({ kind: "tool", name: "write", phase: "end" });
      if (kind === "approval-rejected") {
        const approvals = f.execution.connectApprovals("turn", {
          alive: () => true,
          answer: () => {
            throw new Error("No decision was made");
          },
          cancel: () => {},
        });
        approvals.event({
          v: 1,
          kind: "approval-request",
          requestId: randomUUID(),
          sessionId: "native",
          turnId: "native-turn",
          category: "command",
          details: "The running native turn asks for permission",
          choices: [{ id: "deny", label: "Deny", scope: "deny" }],
        });
        approvals.closed();
      }
      if (kind === "rejected" || kind === "partial-rejected" || kind === "approval-rejected")
        f.event({ kind: "failure", class: "rejected", message: "Synthetic refusal" });
      if (kind !== "lost") f.event({ kind: "done", cause: "failed", exitCode: 2 });
      f.execution.close();
      expect(f.host.state().executions.input).toMatchObject({
        kind: "attempt-ended",
        outcome: {
          kind:
            kind === "rejected"
              ? "pre-start-failed"
              : kind === "lost"
                ? "uncertain"
                : "failed-after-start",
        },
      });
      expect(f.host.contextCoverage("claude", "native")).toBe(0);
      expect(existsSync(f.path)).toBe(false);
      expect(f.host.transcript().inputs).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);

test("lost executor authority refuses settlement and leaves durable recovery evidence", async () => {
  const f = await setup();
  try {
    f.event({ kind: "done", cause: "clean", exitCode: 0 });
    f.dropLease();
    expect(() => f.execution.turnSettled("turn")).toThrow("Execution settlement was refused");
    expect(f.host.state().executions.input?.kind).toBe("attempt-started");
    expect(existsSync(f.path)).toBe(false);
  } finally {
    f.close();
  }
});
