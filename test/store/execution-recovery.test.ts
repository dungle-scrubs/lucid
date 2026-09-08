import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lucid-execution-recovery-"));
  const { paths, secret } = createConversationRecord(root, "recovery");
  let now = 1;
  let executor = true;
  const open = () =>
    createConversationHost(paths.dir, {
      now: () => now,
      presence: () => false,
      executorLease: () => executor,
      onEffect: () => {},
      onRecord: () => {},
    });
  let host = open();
  const attach = () =>
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "recovery",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
        capabilities: ["managed-input-v1"],
        attachmentOrigin: "automatic",
      }),
    );
  expect(
    host.acceptInput(
      { id: "original", text: "Perform this task once", mode: "queue" },
      { managed: true },
    ).verdict,
  ).toBe("accepted");
  expect(attach().verdict).toBe("accepted");
  const start = {
    kind: "attempt-started",
    epoch: 1,
    attempt: 1,
    inputId: "original",
    turnId: "first-turn",
    driver: { harness: "claude", model: "test-model", effort: "high", profile: "headless-turn" },
    native: { kind: "fresh" },
    context: { digest: "a".repeat(64), from: 0, through: 1 },
  };
  expect(host.writeExecution(start).verdict).toBe("accepted");
  return {
    get host() {
      return host;
    },
    start,
    loseWorker: () => {
      host.close();
      now += 1_000_000;
      host = open();
    },
    attach,
    noLease: () => {
      executor = false;
    },
    close: () => {
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("takeover reconciles a durable terminal result without applying or executing again", () => {
  const f = fixture();
  try {
    expect(
      f.host.handleFrame(
        JSON.stringify({ kind: "disposition", epoch: 1, inputId: "original", outcome: "applied" }),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "first-turn",
          event: { kind: "done", cause: "clean", exitCode: 0 },
        }),
      ).verdict,
    ).toBe("accepted");
    const terminalSeq = f.host.state().seq;
    f.loseWorker();
    expect(f.attach().verdict).toBe("accepted");
    const recovered = f.host.reconcileExecution("original", 1);
    expect(recovered.verdict).toBe("accepted");
    expect(recovered.effects).toEqual([]);
    expect(f.host.state().executions.original).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "completed", terminalSeq },
    });
    const seq = f.host.state().seq;
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.transcript().inputs).toHaveLength(1);
    f.loseWorker();
    expect(f.host.state().executions.original).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "completed", terminalSeq },
    });
  } finally {
    f.close();
  }
});

test("a recorded unsuccessful terminal event preserves partial output as a failed attempt", () => {
  const f = fixture();
  try {
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "first-turn",
          event: { kind: "message", role: "assistant", text: "Partial work was written" },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 2,
          turnId: "first-turn",
          event: { kind: "done", cause: "error", exitCode: 1 },
        }),
      ).verdict,
    ).toBe("accepted");
    f.loseWorker();
    expect(f.attach().verdict).toBe("accepted");
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("accepted");
    expect(f.host.state().executions.original).toMatchObject({
      kind: "attempt-ended",
      outcome: {
        kind: "failed-after-start",
        failure: { code: "E-HUB-07", evidence: "terminal-error" },
      },
    });
    expect(
      f.host.transcript().events.some((row) => row.event.text === "Partial work was written"),
    ).toBe(true);
  } finally {
    f.close();
  }
});

test("loss before any process evidence stays uncertain and requires explicit fresh recovery", () => {
  const f = fixture();
  try {
    expect(f.host.reconcileExecution("original", 1)).toMatchObject({
      verdict: "refused",
      issue: "execution-ineligible",
    });
    expect(f.host.reconcileExecution("absent", 1)).toMatchObject({
      verdict: "refused",
      issue: "unknown-input",
    });
    f.loseWorker();
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("refused");
    expect(f.attach().verdict).toBe("accepted");
    expect(f.host.reconcileExecution("original", 0)).toMatchObject({
      verdict: "refused",
      issue: "execution-stale",
    });
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("accepted");
    expect(f.host.state().executions.original).toMatchObject({
      kind: "attempt-ended",
      outcome: {
        kind: "uncertain",
        failure: { code: "E-HUB-07", evidence: "process-lost" },
      },
    });
    expect(
      f.host.acceptInput({ id: "later", text: "Later work", mode: "queue" }, { managed: true })
        .verdict,
    ).toBe("accepted");
    expect(
      f.host.writeExecution({ ...f.start, epoch: 2, inputId: "later", turnId: "later-turn" })
        .verdict,
    ).toBe("refused");
    const action = {
      kind: "fresh-authorized",
      actionId: "acknowledge-once",
      inputId: "original",
      attempt: 1,
      acknowledgeEffects: true,
    };
    expect(f.host.writeExecution({ ...action, acknowledgeEffects: false }).verdict).toBe("refused");
    expect(f.host.writeExecution({ ...action, kind: "retry-authorized" }).verdict).toBe("refused");
    expect(f.host.writeExecution(action).verdict).toBe("accepted");
    const seq = f.host.state().seq;
    expect(f.host.writeExecution(action).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("refused");
    expect(
      f.host.writeExecution({ ...f.start, epoch: 2, attempt: 2, turnId: "fresh-turn" }).verdict,
    ).toBe("accepted");
    expect(f.host.transcript().inputs).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("a host without the executor lease cannot reconcile a departed worker", () => {
  const f = fixture();
  try {
    f.loseWorker();
    expect(f.attach().verdict).toBe("accepted");
    f.noLease();
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("refused");
    expect(f.host.state().executions.original?.kind).toBe("attempt-started");
  } finally {
    f.close();
  }
});

test("an acknowledged asking turn completes its attempt while preserving the question", () => {
  const f = fixture();
  try {
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "first-turn",
          event: {
            kind: "question",
            question: "Which workspace should change?",
            options: ["First", "Second"],
          },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 2,
          turnId: "first-turn",
          event: { kind: "done", cause: "awaiting-input", exitCode: 0 },
        }),
      ).verdict,
    ).toBe("accepted");
    const terminalSeq = f.host.state().seq;
    f.loseWorker();
    expect(f.attach().verdict).toBe("accepted");
    expect(f.host.reconcileExecution("original", 1).verdict).toBe("accepted");
    f.loseWorker();
    expect(f.host.state().executions.original).toMatchObject({
      kind: "attempt-ended",
      outcome: { kind: "completed", terminalSeq },
    });
    expect(
      f.host
        .transcript()
        .events.some((row) => row.event.question === "Which workspace should change?"),
    ).toBe(true);
    expect(
      f.host.acceptInput(
        { id: "answer", text: "The first workspace", mode: "queue" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    expect(f.host.transcript().inputs).toHaveLength(2);
  } finally {
    f.close();
  }
});
