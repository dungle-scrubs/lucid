import { describe, expect, test } from "bun:test";
import { EventKind } from "../../src/protocol/events.js";
import { enqueueInput, reduce } from "../../src/protocol/reducer.js";
import { attach, drive, event, expectAccepted, expectRefused, fresh } from "./helpers.js";

const question = (turnId: string, q = "Q?") =>
  event({ n: 1, turnId, event: { kind: EventKind.question, question: q } });
const questionN = (n: number, turnId: string, q = "Q?") =>
  event({ n, turnId, event: { kind: EventKind.question, question: q } });

describe("stale-answer (RFC-05 R4,R5)", () => {
  test("answer naming a turn that is not the open question is refused stale-answer", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1"), 2_000],
    ]);
    const r = expectRefused(
      enqueueInput(state, { id: "ans-1", text: "x", mode: "answer", turnId: "t-2" }, 3_000),
    );
    expect(r.issue).toBe("stale-answer");
    expect(r.state).toBe(state);
    // question remains open, not consumed
    expect(r.state.questionOpen?.turnId).toBe("t-1");
  });

  test("answer when no question is open is refused stale-answer", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);
    const r = expectRefused(
      enqueueInput(state, { id: "ans-1", text: "x", mode: "answer", turnId: "t-1" }, 2_000),
    );
    expect(r.issue).toBe("stale-answer");
    expect(r.state.questionOpen).toBeNull();
  });

  test("second answer while one is already awaiting outcome is refused stale-answer", () => {
    const base = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1"), 2_000],
    ]);
    const first = expectAccepted(
      enqueueInput(base, { id: "ans-1", text: "first", mode: "answer", turnId: "t-1" }, 3_000),
    );
    expect(first.state.questionOpen?.answeringInputId).toBe("ans-1");
    const second = expectRefused(
      enqueueInput(
        first.state,
        { id: "ans-2", text: "second", mode: "answer", turnId: "t-1" },
        3_001,
      ),
    );
    expect(second.issue).toBe("stale-answer");
    // still reserved for first
    expect(second.state.questionOpen?.answeringInputId).toBe("ans-1");
  });

  test("refused answer does not consume the open question - the person can try again with fresh id", () => {
    const base = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1"), 2_000],
    ]);
    // first answer names wrong turn, refused
    const refused = expectRefused(
      enqueueInput(base, { id: "ans-bad", text: "x", mode: "answer", turnId: "t-999" }, 3_000),
    );
    expect(refused.issue).toBe("stale-answer");
    expect(refused.state.questionOpen?.turnId).toBe("t-1");
    expect(refused.state.questionOpen?.answeringInputId).toBeUndefined();
    // retry with correct turn and fresh id succeeds
    const retry = expectAccepted(
      enqueueInput(
        refused.state,
        { id: "ans-good", text: "x", mode: "answer", turnId: "t-1" },
        3_001,
      ),
    );
    expect(retry.state.questionOpen?.answeringInputId).toBe("ans-good");
  });

  test("resending kept text uses a fresh input id - reusing refused id after accepted would be duplicate, but refused is not stored so fresh is required for clarity", () => {
    const base = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1"), 2_000],
    ]);
    const refused = expectRefused(
      enqueueInput(base, { id: "ans-1", text: "kept text", mode: "answer", turnId: "t-2" }, 3_000),
    );
    expect(refused.issue).toBe("stale-answer");
    // The draft was kept; resending with a fresh id and correct turn succeeds
    const freshRetry = expectAccepted(
      enqueueInput(
        refused.state,
        { id: "ans-2", text: "kept text", mode: "answer", turnId: "t-1" },
        3_001,
      ),
    );
    expect(freshRetry.verdict).toBe("accepted");
    // If we instead retry with the same id but correct turn, it would be accepted too (since refused ids are not stored)
    // The ticket says to use a fresh id; reusing would be confusing because the next failure would be attributed to identity rather than staleness if the id had been accepted before.
    // Here we show that after a successful answer, reusing its id draws duplicate
    const dup = expectRefused(
      enqueueInput(
        freshRetry.state,
        { id: "ans-2", text: "again", mode: "answer", turnId: "t-1" },
        3_002,
      ),
    );
    // Now reservation blocks, so stale before duplicate? Actually duplicate check is before stale, so duplicate wins
    expect(dup.issue).toBe("input-id-reused");
  });

  test("replacing a question carries its reservation with it, so a late outcome for the old question cannot clear the new one", () => {
    // Q1 open, answer ans-1 pending
    const base = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1", "Q1?"), 2_000],
    ]);
    const withAns = expectAccepted(
      enqueueInput(base, { id: "ans-1", text: "a", mode: "answer", turnId: "t-1" }, 3_000),
    );
    expect(withAns.state.questionOpen?.turnId).toBe("t-1");
    expect(withAns.state.questionOpen?.answeringInputId).toBe("ans-1");
    // Q2 replaces Q1 - takes turn t-2, reservation should not be inherited (old reservation carries with old question)
    const withQ2 = expectAccepted(reduce(withAns.state, questionN(2, "t-2", "Q2?"), 3_001));
    expect(withQ2.state.questionOpen?.turnId).toBe("t-2");
    // New question has no reservation (old reservation left with old question)
    expect(withQ2.state.questionOpen?.answeringInputId).toBeUndefined();
    // Late applied for old answer ans-1 should NOT clear new question
    const afterOldApplied = expectAccepted(
      reduce(
        withQ2.state,
        { kind: "disposition", epoch: 1, inputId: "ans-1", outcome: "applied" },
        3_002,
      ),
    );
    expect(afterOldApplied.state.questionOpen?.turnId).toBe("t-2");
    // And we can now answer Q2
    const ans2 = expectAccepted(
      enqueueInput(
        afterOldApplied.state,
        { id: "ans-2", text: "b", mode: "answer", turnId: "t-2" },
        3_003,
      ),
    );
    expect(ans2.state.questionOpen?.answeringInputId).toBe("ans-2");
  });

  test("replayed answer is delivered as ordinary input (queue)", () => {
    // Enqueue an answer while a question is open, do not apply it, then attach.
    const base = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1"), 2_000],
    ]);
    const withAns = expectAccepted(
      enqueueInput(base, { id: "ans-1", text: "hello", mode: "answer", turnId: "t-1" }, 3_000),
    );
    expect(withAns.state.inputs[0]?.mode).toBe("answer");
    // Attach replay should rewrite answer to queue
    const replayed = expectAccepted(
      reduce(withAns.state, attach({ profile: "headless-session" }), 20_000),
    );
    // The attach-ok effects include replayed inputs
    const sent = replayed.effects.filter(
      (e) => e.type === "send" && (e.frame as { kind: string }).kind === "input",
    );
    expect(sent.length).toBe(1);
    const frame = (sent[0] as { type: "send"; frame: { kind: string; mode: string; text: string } })
      .frame;
    expect(frame.mode).toBe("queue");
    expect(frame.text).toBe("hello");
    // Stored state still has answer mode? Actually inputs after attach are cleared redeliver but keep mode answer
    expect(replayed.state.inputs[0]?.mode).toBe("answer");
  });

  test("replay rewriting is why a replayed answer survives a restart that moved the question", async () => {
    // Simulate a restart: write log with an answer, fold, then ensure folded answer replays as queue.
    // Use the store's foldLog via reducer's attach path - the previous test already proves rewrite.
    // This test covers the restart scenario explicitly: an answer valid when written becomes stale after restart.
    const base = drive(fresh(), [
      [attach(), 1_000],
      [question("t-1"), 2_000],
    ]);
    const withAns = expectAccepted(
      enqueueInput(
        base,
        { id: "ans-1", text: "typed slowly", mode: "answer", turnId: "t-1" },
        3_000,
      ),
    );
    // Simulate that before attach replay, a new question replaced the old one (so answer is now stale)
    const withQ2 = expectAccepted(reduce(withAns.state, questionN(2, "t-2", "New Q?"), 3_001));
    // Now attach: replay should still be queue, not answer, so it won't be refused stale
    const attached = expectAccepted(
      reduce(withQ2.state, attach({ profile: "headless-session" }), 20_000),
    );
    const sent = attached.effects.filter(
      (e) => e.type === "send" && (e.frame as { kind: string }).kind === "input",
    );
    expect(sent[0] && (sent[0] as { frame: { mode: string } }).frame.mode).toBe("queue");
  });
});
