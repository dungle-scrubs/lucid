import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceContextCoverage } from "../../src/protocol/context-coverage.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

test("session coverage survives A to B to A and never claims a concurrent prompt was consumed", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-coverage-"));
  const { paths, secret } = createConversationRecord(root, "coverage");
  const open = () =>
    createConversationHost(paths.dir, {
      now: () => 1,
      presence: () => false,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
  let host = open();
  let epoch = 0;
  let n = 0;
  const attach = (harness: "claude" | "codex") => {
    if (epoch > 0)
      expect(
        host.handleFrame(JSON.stringify({ kind: "detach", epoch, reason: "shutdown" })).verdict,
      ).toBe("accepted");
    const result = host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "coverage",
        secret,
        version: 1,
        harness,
        profile: "headless-turn",
      }),
    );
    expect(result.verdict).toBe("accepted");
    epoch = host.state().epoch;
    n = 0;
  };
  const event = (turnId: string, payload: Record<string, unknown>) => {
    const result = host.handleFrame(
      JSON.stringify({ kind: "event", epoch, n: ++n, turnId, event: payload }),
    );
    expect(result.verdict).toBe("accepted");
    return host.state().seq;
  };
  try {
    attach("claude");
    event("a1", { kind: "identity", sessionId: "native-a", authority: "harness-minted" });
    const offer = {
      harness: "claude" as const,
      sessionId: "native-a",
      turnId: "a1",
      context: { from: 0, through: host.state().seq + 1, digest: "a".repeat(64) },
    };
    expect(host.offerConversationContext(offer).verdict).toBe("accepted");
    expect(host.confirmConversationContext("a1").verdict).toBe("refused");
    const accepted = host.acceptInput({
      id: "concurrent",
      text: "A request arriving during the turn",
      mode: "queue",
    });
    if (accepted.verdict !== "accepted") throw new Error("input failed");
    event("a1", { kind: "message", role: "assistant", text: "First result" });
    const aEnd = event("a1", { kind: "done", cause: "clean", exitCode: 0 });
    expect(
      reduceContextCoverage(
        host.state(),
        {
          ...offer,
          epoch,
          kind: "coverage-confirmed",
          evidence: { kind: "completed-turn", seq: aEnd },
          through: aEnd + 1,
        },
        1,
        true,
      ).verdict,
    ).toBe("refused");
    expect(host.confirmConversationContext("a1").verdict).toBe("accepted");
    expect(host.contextCoverage("claude", "native-a")).toBe(accepted.receipt.seq);
    const confirmed = host.state().seq;
    expect(host.confirmConversationContext("a1").verdict).toBe("accepted");
    expect(host.state().seq).toBe(confirmed);
    attach("codex");
    event("b1", { kind: "identity", sessionId: "native-b", authority: "harness-minted" });
    expect(
      host.offerConversationContext({
        harness: "codex",
        sessionId: "native-b",
        turnId: "b1",
        context: { from: 0, through: host.state().seq + 1, digest: "b".repeat(64) },
      }).verdict,
    ).toBe("accepted");
    event("b1", { kind: "message", role: "assistant", text: "Work performed in B" });
    const bEnd = event("b1", { kind: "done", cause: "clean", exitCode: 0 });
    expect(host.confirmConversationContext("b1").verdict).toBe("accepted");
    expect(host.contextCoverage("codex", "native-b")).toBe(bEnd + 1);
    host.close();
    host = open();
    expect(host.contextCoverage("claude", "native-a")).toBe(accepted.receipt.seq);
    attach("claude");
    event("a2", { kind: "identity", sessionId: "native-a", authority: "harness-minted" });
    expect(
      host.offerConversationContext({
        ...offer,
        turnId: "a2",
        context: {
          ...offer.context,
          from: host.contextCoverage("claude", "native-a"),
          through: host.state().seq + 1,
        },
      }).verdict,
    ).toBe("accepted");
    // Offering is not confirmation, including after reopen.
    host.close();
    host = open();
    expect(host.contextCoverage("claude", "native-a")).toBe(accepted.receipt.seq);
    expect(host.transcript().events.find((row) => row.turnId === "b1")?.harness).toBe("codex");
  } finally {
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("completed output cannot retroactively authorize an offer of context it never saw", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-late-offer-"));
  const { paths, secret } = createConversationRecord(root, "late-offer");
  const host = createConversationHost(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => true,
    onEffect: () => {},
    onRecord: () => {},
  });
  try {
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "late-offer",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
      }),
    );
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "finished",
        event: { kind: "identity", sessionId: "native", authority: "harness-minted" },
      }),
    );
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 2,
        turnId: "finished",
        event: { kind: "done", exitCode: 0, cause: "clean" },
      }),
    );
    const before = host.state().seq;
    expect(
      host.offerConversationContext({
        harness: "claude",
        sessionId: "native",
        turnId: "finished",
        context: { digest: "a".repeat(64), from: 0, through: before + 1 },
      }).verdict,
    ).toBe("refused");
    expect(host.state().seq).toBe(before);
    expect(host.contextCoverage("claude", "native")).toBe(0);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed native identity within the supplying turn cannot confirm the old session", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-identity-change-"));
  const { paths, secret } = createConversationRecord(root, "identity-change");
  const host = createConversationHost(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => true,
    onEffect: () => {},
    onRecord: () => {},
  });
  const event = (n: number, payload: Record<string, unknown>) =>
    host.handleFrame(
      JSON.stringify({ kind: "event", epoch: 1, n, turnId: "turn", event: payload }),
    );
  try {
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "identity-change",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
      }),
    );
    event(1, { kind: "identity", sessionId: "first-native", authority: "harness-minted" });
    expect(
      host.offerConversationContext({
        harness: "claude",
        sessionId: "first-native",
        turnId: "turn",
        context: { from: 0, through: host.state().seq + 1, digest: "d".repeat(64) },
      }).verdict,
    ).toBe("accepted");
    event(2, { kind: "identity", sessionId: "different-native", authority: "harness-minted" });
    event(3, { kind: "done", cause: "clean", exitCode: 0 });
    expect(host.confirmConversationContext("turn").verdict).toBe("refused");
    expect(host.contextCoverage("claude", "first-native")).toBe(0);
    expect(host.contextCoverage("claude", "different-native")).toBe(0);
  } finally {
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("a successful persistent-session turn confirms context without a process exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-session-coverage-"));
  const { paths, secret } = createConversationRecord(root, "session-coverage");
  const host = createConversationHost(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => true,
    onEffect: () => {},
    onRecord: () => {},
  });
  try {
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "session-coverage",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-session",
      }),
    );
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "session-turn",
        event: { kind: "identity", sessionId: "native", authority: "harness-minted" },
      }),
    );
    host.offerConversationContext({
      harness: "claude",
      sessionId: "native",
      turnId: "session-turn",
      context: { digest: "a".repeat(64), from: 0, through: host.state().seq + 1 },
    });
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 2,
        turnId: "session-turn",
        event: { kind: "done", exitCode: null, cause: "clean" },
      }),
    );
    const through = host.state().seq + 1;
    expect(host.confirmConversationContext("session-turn").verdict).toBe("accepted");
    expect(host.contextCoverage("claude", "native")).toBe(through);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery confirms a completed managed attempt from its pre-dispatch offer and actual native identity", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-recovered-coverage-"));
  const { paths, secret } = createConversationRecord(root, "recovered-coverage");
  const open = () =>
    createConversationHost(paths.dir, {
      now: () => 1,
      presence: () => false,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
  let host = open();
  try {
    host.acceptInput({ id: "task", text: "Continue", mode: "queue" }, { managed: true });
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "recovered-coverage",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
        capabilities: ["managed-input-v1"],
        attachmentOrigin: "automatic",
      }),
    );
    expect(
      host.writeExecution({
        kind: "attempt-started",
        inputId: "task",
        attempt: 1,
        epoch: 1,
        turnId: "task-turn",
        driver: { harness: "claude", profile: "headless-turn", model: "concrete", effort: "high" },
        native: { kind: "fresh" },
        context: { from: 0, through: host.state().seq + 1, digest: "c".repeat(64) },
      }).verdict,
    ).toBe("accepted");
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "task-turn",
        event: { kind: "identity", sessionId: "actual-session", authority: "harness-minted" },
      }),
    );
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 2,
        turnId: "task-turn",
        event: { kind: "done", exitCode: 0, cause: "clean" },
      }),
    );
    const through = host.state().seq + 1;
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 3,
        turnId: "later-turn",
        event: { kind: "identity", sessionId: "later-session", authority: "harness-minted" },
      }),
    );
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 4,
        turnId: "later-turn",
        event: { kind: "done", exitCode: 0, cause: "clean" },
      }),
    );
    host.close();
    host = open();
    expect(host.confirmConversationContext("task-turn").verdict).toBe("accepted");
    expect(host.contextCoverage("claude", "actual-session")).toBe(through);
    expect(host.contextCoverage("claude", "later-session")).toBe(0);
    const fact = readFileSync(paths.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(fact).toMatchObject({
      src: "context",
      payloadVersion: 1,
      fact: {
        kind: "coverage-confirmed",
        harness: "claude",
        sessionId: "actual-session",
        managed: { attempt: 1, inputId: "task" },
        context: { from: 0 },
        evidence: { kind: "completed-turn" },
      },
    });
    host.close();
    host = open();
    expect(host.contextCoverage("claude", "actual-session")).toBe(through);
    expect(host.transcript().inputs).toHaveLength(1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
