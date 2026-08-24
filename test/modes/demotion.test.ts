import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner, SessionHandle } from "../../src/harness/runner.js";
import { createHeadlessHost } from "../../src/modes/host.js";
import type { Frame } from "../../src/protocol/index.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

const makeRunner = (
  calls: string[],
  texts: Record<string, string>,
  opts: { demoteFirstAnswer?: boolean; emitQuestion?: boolean } = {},
): HarnessRunner => {
  let answerCalls = 0;
  const questionTurnId = "t-ask-1";
  const handle: SessionHandle = {
    turns: {
      async *[Symbol.asyncIterator]() {
        if (opts.emitQuestion) {
          // Emit a turn that asks a question - this goes through the host pump and sequencer, so n stays in sync
          const qTurn: any = {
            turnId: questionTurnId,
            inputId: "init",
            [Symbol.asyncIterator]: async function* () {
              yield { kind: "question", question: "Q?", options: [] };
              yield { kind: "done", exitCode: null, cause: "awaiting-input" };
            },
          };
          yield qTurn;
          // Keep the session alive after the question turn
          await new Promise(() => {});
        } else {
          await new Promise(() => {});
        }
      },
    } as unknown as AsyncIterable<any>,
    send: async (id: string, text: string) => {
      calls.push(`send:${id}`);
      texts[id] = text;
      return { disposition: "started" as const };
    },
    answer: async (id: string, text: string) => {
      calls.push(`answer:${id}`);
      texts[id] = text;
      answerCalls++;
      if (opts.demoteFirstAnswer && answerCalls === 1) {
        return { disposition: "rejected" as const, reason: "no-open-question" };
      }
      return { disposition: "started" as const };
    },
    close: async () => ({ exitCode: 0, cause: "clean" as const }),
  };
  return {
    openSession: async () => handle,
    streamTurn: () => ({ [Symbol.asyncIterator]: async function* () {} }) as any,
    inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "test" }),
    capabilities: async () => ({
      vision: false,
      images: false,
      streaming: "no",
      session: true,
      source: "runtime-verified" as const,
      confidence: "high" as const,
    }),
  };
};

describe("demotion (RFC-05 Error Handling)", () => {
  test("an answer is delivered through harness answer path, not send", async () => {
    const calls: string[] = [];
    const texts: Record<string, string> = {};
    const runner = makeRunner(calls, texts, { emitQuestion: true });
    const root = mkdtempSync(join(tmpdir(), "lucid-demotion2-"));
    const { secret: s2 } = createConversationRecord(root, "conv-1");
    const rec2: unknown[] = [];
    let recv2: (f: Frame) => void = () => {};
    const host2 = openConversation(join(root, "conv-1"), {
      now: () => 0,
      presence: () => undefined,
      executorLease: () => true,
      onRecord: (r) => rec2.push(r),
      onEffect: (e) => {
        if (e.type === "send") recv2(e.frame);
      },
    });
    let tCounter = 10;
    const src = createHeadlessHost(
      {
        harness: "claude",
        conversationId: "conv-1",
        secret: s2,
        runner,
        mintTurnId: () => `turn-${++tCounter}`,
        sendFrame: (f) => host2.handleFrame(JSON.stringify(f)),
        host: {
          cursor: () => host2.cursor(),
          collectEffects: (o) => host2.collectEffects(o),
          advanceCursor: (o) => host2.advanceCursor(o),
        },
        sessionId: sid,
      },
      "headless-session",
    );
    recv2 = src.receive;
    // Wait for question to be emitted via handle's turns
    for (let i = 0; i < 20; i++) {
      await flush();
      if (host2.state().questionOpen !== null) break;
    }
    const q = host2.state().questionOpen;
    expect(q).not.toBeNull();
    const qTurnId = q?.turnId;
    host2.enqueueInput({ id: "ans-1", text: "raw words", mode: "answer", turnId: qTurnId });
    await flush();
    await flush();
    expect(texts["ans-1"]).toBe("raw words");
    expect(calls).toContain("answer:ans-1");
    expect(calls.filter((c) => c.startsWith("send:"))).toHaveLength(0);
    src.close();
    host2.close();
  });

  test("a refused answer is retried once as ordinary input with same words, single outcome, not armed for redelivery, error in transcript, question cleared", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-demotion-"));
    const { secret } = createConversationRecord(root, "conv-1");
    const records: unknown[] = [];
    let receive2: (f: Frame) => void = () => {};
    const host = openConversation(join(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onRecord: (r) => records.push(r),
      onEffect: (e) => {
        if (e.type === "send") receive2(e.frame);
      },
    });
    const calls: string[] = [];
    const texts: Record<string, string> = {};
    const runner = makeRunner(calls, texts, { emitQuestion: true, demoteFirstAnswer: true });
    let tCounter = 10;
    const src = createHeadlessHost(
      {
        harness: "claude",
        conversationId: "conv-1",
        secret,
        runner,
        mintTurnId: () => `turn-${++tCounter}`,
        sendFrame: (f) => host.handleFrame(JSON.stringify(f)),
        host: {
          cursor: () => host.cursor(),
          collectEffects: (o) => host.collectEffects(o),
          advanceCursor: (o) => host.advanceCursor(o),
        },
        sessionId: sid,
      },
      "headless-session",
    );
    receive2 = src.receive;
    for (let i = 0; i < 20; i++) {
      await flush();
      if (host.state().questionOpen !== null) break;
    }
    const q = host.state().questionOpen;
    expect(q).not.toBeNull();
    const qTurnId = q?.turnId;
    host.enqueueInput({ id: "ans-1", text: "same words", mode: "answer", turnId: qTurnId });
    await flush();
    await flush();
    await flush();
    await flush();
    expect(calls).toEqual(["answer:ans-1", "send:ans-1"]);
    expect(texts["ans-1"]).toBe("same words");
    const dispositions = (
      records as Array<{ kind?: string; inputId?: string; outcome?: string }>
    ).filter((r) => r.kind === "disposition" && r.inputId === "ans-1");
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]?.outcome).toBe("applied");
    const q2 = host.state().inputs.find((i) => i.id === "ans-1");
    expect(q2).toBeUndefined();
    expect(host.state().appliedInputs["ans-1"]).toBe(true);
    expect(host.state().inputs.some((i) => i.redeliver && i.id === "ans-1")).toBe(false);
    const transcript = host.transcript();
    const errorEvents = transcript.events.filter(
      (e) => e.event?.kind === "error" && !e.event?.terminal,
    );
    expect(
      errorEvents.some(
        (e) =>
          e.event !== undefined &&
          typeof (e.event as { message?: unknown }).message === "string" &&
          String((e.event as { message: unknown }).message).includes("no-open-question"),
      ),
    ).toBe(true);
    expect(host.state().questionOpen).toBeNull();
    const allMessages = transcript.events
      .map((e) =>
        e.event !== undefined ? String((e.event as { message: unknown }).message ?? "") : "",
      )
      .join(" ");
    expect(allMessages).not.toContain("user answered");
    src.close();
    host.close();
  });
});
