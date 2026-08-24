import { describe, expect, test } from "bun:test";
import { HARNESS_AWAITING_INPUT } from "../../src/harness/events.js";
import { EventKind } from "../../src/protocol/events.js";
import { enqueueInput, reduce } from "../../src/protocol/reducer.js";
import { foldLog } from "../../src/store/log.js";
import { attach, drive, event, fresh } from "./helpers.js";

describe("questionOpen (RFC-05 R1)", () => {
  test("reports the open question and the turn that asked it", () => {
    const state = drive(fresh(), [[attach(), 1000]]);
    const r = reduce(
      state,
      event({
        n: 1,
        turnId: "t-1",
        event: { kind: EventKind.question, question: "What?", options: ["a"], recommended: "a" },
      }),
      2000,
    );
    expect(r.verdict).toBe("accepted");
    if (r.verdict !== "accepted") throw new Error("not accepted");
    expect(r.state.questionOpen).toEqual({
      turnId: "t-1",
      question: "What?",
      options: ["a"],
      recommended: "a",
    });
  });

  test("the done that ends an asking turn leaves the question open", () => {
    const state = drive(fresh(), [
      [attach(), 1000],
      [event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }), 2000],
    ]);
    const r = reduce(
      state,
      event({
        n: 2,
        turnId: "t-1",
        event: { kind: EventKind.done, exitCode: 0, cause: HARNESS_AWAITING_INPUT },
      }),
      3000,
    );
    expect(r.verdict).toBe("accepted");
    if (r.verdict !== "accepted") throw new Error("not accepted");
    expect(r.state.questionOpen?.turnId).toBe("t-1");

    // And it survives because the done shares the asking turn's id, not
    // because of its cause. A done on ANOTHER turn is the conversation
    // moving on, and that does clear it - which is the distinction the
    // rule actually rests on.
    const moved = reduce(
      r.state,
      event({
        n: 3,
        turnId: "t-2",
        event: { kind: EventKind.done, exitCode: 0, cause: HARNESS_AWAITING_INPUT },
      }),
      4000,
    );
    expect(moved.verdict).toBe("accepted");
    if (moved.verdict !== "accepted") throw new Error("not accepted");
    expect(moved.state.questionOpen).toBeNull();
  });

  test("any other terminal cause leaves an open question alone (same turn)", () => {
    const state = drive(fresh(), [
      [attach(), 1000],
      [event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }), 2000],
    ]);
    const r = reduce(
      state,
      event({ n: 2, turnId: "t-1", event: { kind: EventKind.done, exitCode: 0, cause: "stop" } }),
      3000,
    );
    expect(r.verdict).toBe("accepted");
    if (r.verdict !== "accepted") throw new Error("no");
    expect(r.state.questionOpen?.turnId).toBe("t-1");
  });

  test("clears on first accepted event of an unrelated turn", () => {
    const state = drive(fresh(), [
      [attach(), 1000],
      [event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }), 2000],
    ]);
    const r = reduce(
      state,
      event({
        n: 2,
        turnId: "t-2",
        event: { kind: EventKind.message, role: "assistant", text: "hello" },
      }),
      3000,
    );
    expect(r.verdict).toBe("accepted");
    if (r.verdict !== "accepted") throw new Error("no");
    expect(r.state.questionOpen).toBeNull();
  });

  test("clears on detach", () => {
    const state = drive(fresh(), [
      [attach(), 1000],
      [event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }), 2000],
    ]);
    const r = reduce(state, { kind: "detach", epoch: 1, reason: "yield" }, 3000);
    expect(r.verdict).toBe("accepted");
    if (r.verdict !== "accepted") throw new Error("no");
    expect(r.state.questionOpen).toBeNull();
  });

  test("survives a fold", () => {
    const raw = Buffer.from(
      `${[
        JSON.stringify({
          v: 1,
          at: 1000,
          src: "frame",
          frame: {
            kind: "attach",
            conversationId: "conv-1",
            profile: "interactive",
            secret: "s3cret",
            version: 1,
          },
        }),
        JSON.stringify({
          v: 1,
          at: 2000,
          src: "frame",
          frame: {
            kind: "event",
            epoch: 1,
            n: 1,
            turnId: "t-1",
            event: { kind: EventKind.question, question: "Persisted?" },
          },
        }),
      ].join("\n")}\n`,
    );
    const folded = foldLog("conv-1", "s3cret", raw);
    expect(folded.state.questionOpen).toEqual({ turnId: "t-1", question: "Persisted?" });
  });

  test("HARNESS_AWAITING_INPUT is the named awaiting-input cause", () => {
    expect(HARNESS_AWAITING_INPUT).toBe("awaiting-input");
  });
});
