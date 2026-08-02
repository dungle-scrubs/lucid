import { describe, expect, test } from "bun:test";
import {
  classifyObservedIdentity,
  classifySessionFailure,
  classifySpawnResult,
  SessionIdentityDecoder,
  type StdoutJsonlSessionIdentity,
} from "../src/launch/session-identity.ts";

const codexStrategy: StdoutJsonlSessionIdentity = {
  allowRotation: false,
  event: "thread.started",
  field: "thread_id",
  requiredArgument: "--json",
  source: "stdout-jsonl",
};

describe("bounded stdout JSONL session identity", () => {
  test("decodes a Codex thread id split across chunks without owning output bytes", () => {
    const decoder = new SessionIdentityDecoder("codex", codexStrategy);
    expect(decoder.push('{"type":"thread.started","thread_')).toEqual([]);
    expect(decoder.push('id":"019f-native"}\n')).toEqual([
      {
        identity: { authority: "observed", harness: "codex", sessionId: "019f-native" },
        status: "identity",
      },
    ]);
    expect(decoder.diagnostics()).toEqual([]);
  });

  test("ignores unrelated records and returns every matching identity in order", () => {
    const decoder = new SessionIdentityDecoder("codex", codexStrategy);
    expect(
      decoder.push(
        '{"type":"turn.started","thread_id":"wrong"}\n' +
          '{"type":"thread.started","thread_id":"one"}\n' +
          '{"type":"thread.started","thread_id":"two"}\n',
      ),
    ).toEqual([
      {
        identity: { authority: "observed", harness: "codex", sessionId: "one" },
        status: "identity",
      },
      {
        identity: { authority: "observed", harness: "codex", sessionId: "two" },
        status: "identity",
      },
    ]);
  });

  test("classifies malformed, controlled, oversized, and overflow records as HSI003", () => {
    const decoder = new SessionIdentityDecoder("codex", codexStrategy);
    decoder.push("not json\n");
    decoder.push('{"type":"thread.started","thread_id":"bad\\nvalue"}\n');
    decoder.push(`{"type":"thread.started","thread_id":"${"x".repeat(513)}"}\n`);
    decoder.push("x".repeat(65_537));
    decoder.push("\n");
    expect(decoder.diagnostics().map(({ code }) => code)).toEqual([
      "HSI003",
      "HSI003",
      "HSI003",
      "HSI003",
    ]);
  });

  test("a final record without newline is decoded on finish", () => {
    const decoder = new SessionIdentityDecoder("codex", codexStrategy);
    decoder.push('{"type":"thread.started","thread_id":"last"}');
    expect(decoder.finish()).toEqual([
      {
        identity: { authority: "observed", harness: "codex", sessionId: "last" },
        status: "identity",
      },
    ]);
  });
});

describe("typed identity outcomes", () => {
  const identity = { authority: "observed" as const, harness: "codex", sessionId: "native" };

  test("clean discovered exit without identity is HSI002; nonzero remains process failure", () => {
    expect(classifySpawnResult(0, codexStrategy)).toEqual({
      code: 0,
      error: "HSI002",
      status: "identity-missing",
    });
    expect(classifySpawnResult(9, codexStrategy)).toEqual({
      code: 9,
      status: "process-failed",
    });
    expect(classifySpawnResult(9, codexStrategy, identity)).toEqual({
      code: 9,
      identity,
      status: "process-failed",
    });
    expect(classifySpawnResult(0, codexStrategy, identity)).toEqual({
      code: 0,
      identity,
      status: "completed",
    });
  });

  test("resume confirmation, mismatch, and allowed rotation are distinct", () => {
    expect(classifyObservedIdentity("native", identity, false)).toEqual({
      identity,
      status: "confirmed",
    });
    const rotated = { ...identity, sessionId: "fresh" };
    expect(classifyObservedIdentity("native", rotated, false)).toEqual({
      error: "HSI005",
      observed: rotated,
      requestedSessionId: "native",
      status: "mismatch",
    });
    expect(classifyObservedIdentity("native", rotated, true)).toEqual({
      identity: rotated,
      previousSessionId: "native",
      status: "rotated",
    });
  });

  test("adapter-owned failure classification recognizes only bounded Codex not-found output", () => {
    expect(classifySessionFailure("codex", "Error: no rollout found for thread id abc")).toBe(
      "HSI004",
    );
    expect(classifySessionFailure("claude-code", "no rollout found for thread id abc")).toBeNull();
    expect(classifySessionFailure("codex", "network unavailable")).toBeNull();
    expect(classifySessionFailure("codex", "x".repeat(70_000))).toBeNull();
  });
});
