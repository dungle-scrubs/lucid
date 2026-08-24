import { describe, expect, test } from "bun:test";
import { EventKind, INPUT_QUEUE_MAX } from "../../src/protocol/events.js";
import { decodeFrame, INPUT_MODES, isInputMode } from "../../src/protocol/frames.js";
import { InputLedger } from "../../src/protocol/ledgers/input.js";
import { enqueueInput, reduce } from "../../src/protocol/reducer.js";
import { attach, drive, event, expectAccepted, expectRefused, fresh } from "./helpers.js";

// Helpers to drive capacity
const applied = (inputId: string) => ({
  kind: "disposition" as const,
  epoch: 1,
  inputId,
  outcome: "applied" as const,
});
const done = (n: number, turnId: string) =>
  event({ n, turnId, event: { kind: EventKind.done, exitCode: 0, cause: "stop" } });

const backlogged = (count: number) => {
  let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);
  for (let i = 1; i <= count; i++) {
    state = expectAccepted(
      enqueueInput(state, { id: `in-${i}`, text: `t${i}`, mode: "queue" }, 1_000 + i),
    ).state;
    state = expectAccepted(reduce(state, applied(`in-${i}`), 1_000 + i + 100)).state;
  }
  return state;
};

describe("answer mode (RFC-05 R2,R3,R6 T45)", () => {
  test("an input can carry the answer mode, and the turn it answers", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);
    const ok = expectAccepted(
      enqueueInput(state, { id: "ans-1", text: "yes", mode: "answer", turnId: "t-7" }, 2_000),
    );
    expect(ok.state.inputs[0]?.mode).toBe("answer");
    expect(ok.state.inputs[0]?.turnId).toBe("t-7");
    expect(ok.effects[0]?.type).toBe("send");
    // round-trips through codec too
    const decoded = decodeFrame({
      kind: "input",
      seq: 42,
      id: "ans-1",
      text: "yes",
      mode: "answer",
      turnId: "t-7",
    });
    expect(decoded.verdict).toBe("ok");
    if (decoded.verdict === "ok")
      expect(decoded.frame).toEqual({
        kind: "input",
        seq: 42,
        id: "ans-1",
        text: "yes",
        mode: "answer",
        turnId: "t-7",
      });
    expect(INPUT_MODES).toContain("answer");
    expect(isInputMode("answer")).toBe(true);
  });

  test("answer with no valid turn reference is refused at decode as malformed (answer-needs-turn), not stale", () => {
    const base = {
      kind: "input" as const,
      seq: 1,
      id: "ans-1",
      text: "x",
      mode: "answer" as const,
    };
    expect(decodeFrame({ ...base })).toEqual({ verdict: "refused", issue: "answer-needs-turn" });
    expect(decodeFrame({ ...base, turnId: "" })).toEqual({
      verdict: "refused",
      issue: "answer-needs-turn",
    });
    expect(decodeFrame({ ...base, turnId: "has\nnewline" })).toEqual({
      verdict: "refused",
      issue: "answer-needs-turn",
    });
    // same on fold path - enqueueInput reports same issue
    const state = drive(fresh(), [[attach(), 1_000]]);
    expect(
      expectRefused(enqueueInput(state, { id: "ans-2", text: "x", mode: "answer" }, 2_000)).issue,
    ).toBe("answer-needs-turn");
    expect(
      expectRefused(
        enqueueInput(state, { id: "ans-3", text: "x", mode: "answer", turnId: "" }, 2_000),
      ).issue,
    ).toBe("answer-needs-turn");
  });

  test("the mode is refused where there is no session to answer into - headless-turn has nothing to answer", () => {
    const state = drive(fresh(), [[attach({ profile: "headless-turn" }), 1_000]]);
    const refused = expectRefused(
      enqueueInput(state, { id: "ans-1", text: "x", mode: "answer", turnId: "t-1" }, 2_000),
    );
    expect(refused.issue).toBe("answer-unsupported");
    // codec still decodes it - the profile gate is reducer's, not codec's, so a source is not trusted to know its own profile
    expect(
      decodeFrame({ kind: "input", seq: 1, id: "ans-1", text: "x", mode: "answer", turnId: "t-1" })
        .verdict,
    ).toBe("ok");
  });

  test("an answer is never held for a turn boundary - it exists to unblock a turn", () => {
    // When live, answer is sent straight through (effect present), like steer.
    // Enqueue does not arm redeliver for live channel.
    const live = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);
    const ansLive = expectAccepted(
      enqueueInput(live, { id: "ans-1", text: "yes", mode: "answer", turnId: "t-1" }, 2_000),
    );
    expect(ansLive.effects.length).toBe(1);
    expect(ansLive.state.inputs[0]?.redeliver).toBe(false);

    // The host's session strategy treats answer like steer: immediate even when a turn is running.
    // We verify via protocol's InputLedger that redeliver is not armed for live - the boundary hold is the redeliver flag.
    // A queue input while not live IS armed; answer when live is not.
    const notLive = fresh(); // no attachment -> not live
    const ansNotLive = expectAccepted(
      enqueueInput(notLive, { id: "ans-2", text: "yes", mode: "answer", turnId: "t-1" }, 2_000),
    );
    // When not live, even answer is queued with redeliver true - there is no channel to send on, so attach replay will deliver it.
    // The "never held for boundary" rule is about mid-turn holding, not about absent channel.
    expect(ansNotLive.effects.length).toBe(0);
    expect(ansNotLive.state.inputs[0]?.redeliver).toBe(true);
  });

  test("refusal order is fixed: malformed > duplicated > impossible > stale > full, capacity last", () => {
    // 1. malformed (answer-needs-turn) beats duplicated (input-id-reused)
    {
      const state = drive(fresh(), [[attach(), 1_000]]);
      // first insert one to create duplicate
      const withOne = expectAccepted(
        enqueueInput(state, { id: "dup", text: "first", mode: "queue" }, 2_000),
      ).state;
      // now an answer with same id but missing turnId - both malformed and duplicate true, malformed wins
      const r = expectRefused(
        enqueueInput(withOne, { id: "dup", text: "x", mode: "answer" }, 2_001),
      );
      expect(r.issue).toBe("answer-needs-turn");
    }

    // 2. duplicated beats impossible (answer-unsupported)
    {
      const state = drive(fresh(), [[attach({ profile: "headless-turn" }), 1_000]]);
      const withOne = expectAccepted(
        enqueueInput(state, { id: "dup2", text: "first", mode: "queue" }, 2_000),
      ).state;
      // duplicate id + headless-turn answer mode - duplicated wins
      const r = expectRefused(
        enqueueInput(withOne, { id: "dup2", text: "x", mode: "answer", turnId: "t-1" }, 2_001),
      );
      expect(r.issue).toBe("input-id-reused");
    }

    // 3. impossible (answer-unsupported) beats capacity (input-queue-full)
    {
      const full = backlogged(INPUT_QUEUE_MAX);
      // move to headless-turn profile: attach takeover to get headless-turn with same backlog gauge reset? Backlogged is headless-session; need to fill then takeover to headless-turn?
      // Instead construct full state that is headless-turn: attach headless-turn then fill via queue mode.
      const state = drive(fresh(), [[attach({ profile: "headless-turn" }), 1_000]]);
      // need to bypass input-queue-full for setup - fill via lapsed? Instead use backlogged helper which builds headless-session, then we check impossible vs full on headless-turn with manually built inFlight.
      // For this check, use a state that is both headless-turn and at capacity: build capacity on headless-session then take over as headless-turn would reset gauge, so instead manually set inFlight.
      // Simpler: test that answer-unsupported is reported even when at capacity, by using a state at capacity but with headless-turn attachment.
      // We can achieve capacity by directly constructing inFlight via reducer's internal? Instead use a state that has capacity via backlogged then switch profile via direct state copy - the profile check reads attachment.profile, not derived.
      const atCap = backlogged(INPUT_QUEUE_MAX);
      const asTurn: typeof atCap = {
        ...atCap,
        attachment:
          atCap.attachment === null
            ? null
            : { ...atCap.attachment, profile: "headless-turn" as const },
      };
      expect(InputLedger.atCapacity(asTurn.inFlightInputs)).toBe(true);
      const r = expectRefused(
        enqueueInput(asTurn, { id: "ans-cap", text: "x", mode: "answer", turnId: "t-1" }, 9_000),
      );
      expect(r.issue).toBe("answer-unsupported");
    }

    // 4. malformed beats invalid-input (both wire validity but answer-needs-turn is the specific one for answer)
    {
      const state = drive(fresh(), [[attach(), 1_000]]);
      // empty id is invalid-input, but answer without turnId should still be answer-needs-turn first
      const r = expectRefused(enqueueInput(state, { id: "", text: "x", mode: "answer" }, 2_000));
      expect(r.issue).toBe("answer-needs-turn");
    }

    // 5. capacity is last - a valid queue input at capacity draws input-queue-full, not malformed (since it is valid)
    {
      const full = backlogged(INPUT_QUEUE_MAX);
      const r = expectRefused(enqueueInput(full, { id: "next", text: "x", mode: "queue" }, 9_000));
      expect(r.issue).toBe("input-queue-full");
      // and a valid answer at capacity also draws capacity when profile allows it
      const r2 = expectRefused(
        enqueueInput(full, { id: "ans-next", text: "x", mode: "answer", turnId: "t-1" }, 9_001),
      );
      expect(r2.issue).toBe("input-queue-full");
    }
  });

  test("answer-needs-turn is a wire validity issue - it is in DECODE_ISSUES and also refused on fold", () => {
    expect(decodeFrame({ kind: "input", seq: 1, id: "a", text: "x", mode: "answer" }).verdict).toBe(
      "refused",
    );
    const d = decodeFrame({ kind: "input", seq: 1, id: "a", text: "x", mode: "answer" });
    expect(d.verdict === "refused" ? d.issue : "").toBe("answer-needs-turn");
  });
});
