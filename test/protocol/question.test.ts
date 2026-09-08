import { describe, expect, test } from "bun:test";
import { EventKind } from "../../src/protocol/events.js";
import { reduce } from "../../src/protocol/reducer.js";
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
        event: { kind: EventKind.done, exitCode: 0, cause: "awaiting-input" },
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
        event: { kind: EventKind.done, exitCode: 0, cause: "awaiting-input" },
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
});

test("a coded demotion clears its question without depending on message wording", () => {
  const state = drive(fresh(), [
    [attach(), 1000],
    [event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }), 2000],
  ]);
  const result = reduce(
    state,
    event({
      n: 2,
      turnId: "t-1",
      event: {
        kind: EventKind.error,
        code: "answer-demoted",
        inputId: "in-1",
        message: "The answer became a new input",
      },
    }),
    3000,
  );
  expect(result.verdict).toBe("accepted");
  if (result.verdict !== "accepted") throw new Error("refused");
  expect(result.state.questionOpen).toBeNull();
});

test.each([
  [{ message: "answer demoted: no-open-question for in-1" }, true],
  [{ message: "no-open-question appeared in a diagnostic" }, false],
  [{ kind: EventKind.message, message: "answer demoted: no-open-question for in-1" }, false],
  [{ message: "answer demoted: no-open-question for in-1\nextra" }, false],
  [{ message: `answer demoted: no-open-question for ${"x".repeat(129)}` }, false],
  [{ message: "answer demoted: no-open-question for " }, false],
  [{ code: "unrecognized", message: "answer demoted: no-open-question for in-1" }, false],
  [{ code: "answer-demoted", message: "changed wording", inputId: "in-1" }, true],
] as const)(
  "demotion compatibility survives replay without another turn: %j",
  (payload, clears) => {
    const frames = [
      attach(),
      event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }),
      event({ n: 2, turnId: "t-1", event: { kind: EventKind.error, ...payload } }),
    ];
    const raw = Buffer.from(
      `${frames.map((frame, i) => JSON.stringify({ v: 1, at: 1000 + i, src: "frame", frame })).join("\n")}\n`,
    );
    expect(foldLog("conv-1", "s3cret", raw).state.questionOpen === null).toBe(clears);
  },
);

test("a legacy demotion clears the question even when its fallback send is rejected", () => {
  const entries = [
    { src: "frame", frame: attach() },
    {
      src: "frame",
      frame: event({ n: 1, turnId: "t-1", event: { kind: EventKind.question, question: "Q?" } }),
    },
    { src: "input", input: { id: "in-1", text: "answer", mode: "answer", turnId: "t-1" } },
    {
      src: "frame",
      frame: event({
        n: 2,
        turnId: "t-1",
        event: { kind: EventKind.error, message: "answer demoted: no-open-question for in-1" },
      }),
    },
    {
      src: "frame",
      frame: { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "rejected" },
    },
  ];
  const raw = Buffer.from(
    `${entries.map((entry, i) => JSON.stringify({ v: 1, at: 1000 + i, ...entry })).join("\n")}\n`,
  );
  const folded = foldLog("conv-1", "s3cret", raw);
  expect(folded.state.questionOpen).toBeNull();
  expect(folded.transcript.inputs[0]?.status).toBe("rejected");
});
