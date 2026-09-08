import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

test("an attempt is durable before dispatch and cannot be started twice after reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-attempt-"));
  const { paths, secret } = createConversationRecord(root, "attempts");
  const open = () =>
    createConversationHost(paths.dir, {
      now: () => 1,
      presence: () => false,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
  const input = { id: "request", mode: "queue" as const, text: "perform task" };
  let host = open();
  try {
    host.acceptInput(input, { managed: true });
    const attached = host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "attempts",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
        capabilities: ["managed-input-v1"],
        attachmentOrigin: "automatic",
      }),
    );
    if (attached.verdict !== "accepted") throw new Error("expected compatible attach");
    expect(
      attached.effects.some(
        (e) => e.type === "send" && e.frame.kind === "input" && e.frame.id === input.id,
      ),
    ).toBe(true);
    const apply = () =>
      host.handleFrame(
        JSON.stringify({ kind: "disposition", epoch: 1, inputId: input.id, outcome: "applied" }),
      );
    expect(apply().verdict).toBe("refused");
    const start = {
      epoch: 1,
      kind: "attempt-started" as const,
      inputId: input.id,
      attempt: 1,
      turnId: "turn-1",
      driver: {
        harness: "claude" as const,
        model: "test-model",
        effort: "high",
        profile: "headless-turn" as const,
      },
      native: { kind: "fresh" as const },
      context: { digest: "a".repeat(64), from: 0, through: 1 },
    };
    expect(host.writeExecution(start).verdict).toBe("accepted");
    expect(apply().verdict).toBe("accepted");
    host.close();
    host = open();
    expect(host.state().executions[input.id]).toMatchObject({
      kind: "attempt-started",
      attempt: 1,
      turnId: "turn-1",
    });
    expect(host.writeExecution(start).verdict).toBe("refused");
    expect(
      host.writeExecution({
        kind: "attempt-ended",
        inputId: input.id,
        attempt: 1,
        turnId: "turn-1",
        outcome: { kind: "completed", terminalSeq: 1 },
      }).verdict,
    ).toBe("refused");
    expect(
      host.writeExecution({
        kind: "attempt-ended",
        inputId: input.id,
        attempt: 1,
        turnId: "turn-1",
        outcome: {
          kind: "uncertain",
          failure: {
            code: "E-HUB-07",
            evidence: "process-lost",
            reason: "The worker stopped. Effects may exist.",
          },
        },
      }).verdict,
    ).toBe("accepted");
    const recover = {
      kind: "fresh-authorized",
      inputId: input.id,
      attempt: 1,
      actionId: "recovery-1",
      acknowledgeEffects: true,
    };
    expect(host.writeExecution({ ...recover, kind: "retry-authorized" }).verdict).toBe("refused");
    expect(host.writeExecution({ ...recover, acknowledgeEffects: false }).verdict).toBe("refused");
    expect(host.writeExecution(recover).verdict).toBe("accepted");
    expect(host.state().executions[input.id]?.previous).toMatchObject({
      outcome: { kind: "uncertain" },
      start: { turnId: "turn-1" },
    });
    const afterRecovery = host.state().seq;
    expect(host.writeExecution(recover).verdict).toBe("accepted");
    expect(host.state().seq).toBe(afterRecovery);
    expect(host.writeExecution({ ...recover, acknowledgeEffects: false }).verdict).toBe("refused");
    expect(host.writeExecution({ ...start, attempt: 2, turnId: "turn-2" }).verdict).toBe(
      "accepted",
    );
    expect(host.writeExecution(recover).verdict).toBe("accepted");
    expect(host.state().executions[input.id]).toMatchObject({
      kind: "attempt-started",
      attempt: 2,
    });
    expect(host.transcript().inputs).toHaveLength(1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy adoption is durable, executor-only, and cannot authorize an already applied input", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-adoption-"));
  const { paths, secret } = createConversationRecord(root, "adoption");
  let lease = false;
  const open = () =>
    createConversationHost(paths.dir, {
      now: () => 1,
      presence: () => false,
      executorLease: () => lease,
      onEffect: () => {},
      onRecord: () => {},
    });
  let host = open();
  const fact = { kind: "legacy-adopted", inputId: "queued", attempt: 0 } as const;
  try {
    host.enqueueInput({ id: "queued", text: "Pending legacy input", mode: "queue" });
    expect(host.writeExecution(fact).verdict).toBe("refused");
    lease = true;
    expect(host.writeExecution(fact).verdict).toBe("accepted");
    host.close();
    host = open();
    expect(host.state().executions.queued).toMatchObject({ kind: "requested", attempt: 0 });
    expect(host.state().inputs.find((input) => input.id === "queued")?.managed).toBe(true);
    expect(host.transcript().inputs).toHaveLength(1);
    expect(host.writeExecution(fact).verdict).toBe("refused");
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "adoption",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
      }),
    );
    host.enqueueInput({ id: "applied", text: "Already dispatched", mode: "queue" });
    expect(
      host.handleFrame(
        JSON.stringify({ kind: "disposition", epoch: 1, inputId: "applied", outcome: "applied" }),
      ).verdict,
    ).toBe("accepted");
    expect(host.writeExecution({ ...fact, inputId: "applied" }).verdict).toBe("refused");
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
