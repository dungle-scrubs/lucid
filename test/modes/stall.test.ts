/**
 * A harness that stops answering says so in the record.
 *
 * The failure this is for: eight inputs were handed to a wedged session and
 * it answered none of them. The record held the inputs and nothing else —
 * no event, no error, not one entry between one input and the next for
 * ninety minutes. A conversation that had stopped was indistinguishable
 * from one that was thinking.
 *
 * Nothing here cancels or retries. The input stays delivered and a late
 * answer lands normally. What changes is that the silence is written down.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { createHeadlessHost } from "../../src/modes/host.js";
import type { Frame } from "../../src/protocol/frames.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

const BIN = "/fake/hcn";
const SID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

/** A source whose harness is alive but says nothing back. */
const rig = (opts: { stallMs: number }) => {
  const root = mkdtempSync(join(tmpdir(), "lucid-stall-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  let clock = 1_000_000;
  const host = openConversation(join(root, "conv-1"), {
    now: () => clock,
    presence: () => undefined,
    executorLease: () => true,
    onRecord: () => {},
    onEffect: () => {},
  });
  let turns = 0;
  const source = createHeadlessHost(
    {
      harness: "claude",
      conversationId: "conv-1",
      secret,
      runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
      mintTurnId: () => `turn-${++turns}`,
      sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
      sessionId: SID,
      now: () => clock,
      stallMs: opts.stallMs,
      // Fast enough that a test does not wait on a real clock.
      stallTickMs: 5,
    } as unknown as Parameters<typeof createHeadlessHost>[0],
    "headless-session",
  );
  proc.emit({
    kind: "session",
    sessionId: SID,
    harness: "claude",
    hcn: "0.5.4",
    escalateQuestions: true,
  });
  return {
    source,
    host,
    proc,
    advance: (ms: number) => {
      clock += ms;
    },
    stalls: () =>
      host
        .transcript()
        .events.filter(
          (e) =>
            (e.event as { kind?: string }).kind === "error" &&
            String((e.event as { message?: string }).message ?? "").includes("has not answered"),
        ),
    done: () => {
      source.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("a harness that answers nothing", () => {
  test("the silence is written into the record", async () => {
    const r = rig({ stallMs: 1_000 });
    try {
      r.source.receive({ kind: "input", seq: 1, id: "in-1", text: "hello", mode: "queue" });
      expect(r.stalls().length).toBe(0);

      // Long enough that a harness thinking would have said something.
      r.advance(2_000);
      await settle();

      const said = r.stalls();
      expect(said.length).toBe(1);
      const first = said[0];
      expect(first).toBeDefined();
      // It says what is wrong and how long it has been, so the reader does
      // not have to compare timestamps to find out.
      const message = String((first?.event as { message?: string })?.message ?? "");
      expect(message).toContain("wedged");
      expect(message).toContain("has not answered");
    } finally {
      r.done();
    }
  });

  test("it is said once, not once per tick", async () => {
    const r = rig({ stallMs: 1_000 });
    try {
      r.source.receive({ kind: "input", seq: 1, id: "in-1", text: "hello", mode: "queue" });
      r.advance(5_000);
      await settle(80);
      expect(r.stalls().length).toBe(1);
    } finally {
      r.done();
    }
  });

  test("a harness that is answering says nothing about stalling", async () => {
    const r = rig({ stallMs: 1_000 });
    try {
      r.source.receive({ kind: "input", seq: 1, id: "in-1", text: "hello", mode: "queue" });
      // It speaks before the watch runs out, which is what a slow harness
      // doing its job looks like.
      r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
      r.proc.emit({ kind: "turn", turnId: "turn-1", id: "in-1" });
      r.proc.emit({ kind: "token", text: "thinking" });
      await settle();
      r.advance(5_000);
      await settle();
      expect(r.stalls().length).toBe(0);
    } finally {
      r.done();
    }
  });

  test("nothing is cancelled: a late answer still lands", async () => {
    const r = rig({ stallMs: 1_000 });
    try {
      r.source.receive({ kind: "input", seq: 1, id: "in-1", text: "hello", mode: "queue" });
      r.advance(2_000);
      await settle();
      expect(r.stalls().length).toBe(1);

      // The harness comes back after the silence was recorded. The input was
      // never withdrawn, so this is an ordinary answer.
      r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
      r.proc.emit({ kind: "turn", turnId: "turn-1", id: "in-1" });
      r.proc.emit({ kind: "message", role: "assistant", text: "sorry, took a while" });
      await settle();

      const texts = r.host
        .transcript()
        .events.map((e) => String((e.event as { text?: string }).text ?? ""));
      expect(texts.some((t) => t.includes("took a while"))).toBe(true);
    } finally {
      r.done();
    }
  });

  test("a second input after a stall re-arms the watch", async () => {
    const r = rig({ stallMs: 1_000 });
    try {
      r.source.receive({ kind: "input", seq: 1, id: "in-1", text: "one", mode: "queue" });
      r.advance(2_000);
      await settle();
      expect(r.stalls().length).toBe(1);

      r.source.receive({ kind: "input", seq: 2, id: "in-2", text: "two", mode: "queue" });
      r.advance(2_000);
      await settle();
      // Two inputs, two silences — the second is not swallowed by the first.
      expect(r.stalls().length).toBe(2);
    } finally {
      r.done();
    }
  });

  test("with nothing handed over there is nothing to report", async () => {
    const r = rig({ stallMs: 1_000 });
    try {
      r.advance(10_000);
      await settle();
      expect(r.stalls().length).toBe(0);
    } finally {
      r.done();
    }
  });
});
