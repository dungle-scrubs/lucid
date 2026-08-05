import { describe, expect, test } from "bun:test";
import { advance, type DeliveryCursor } from "../src/core/fold.ts";
import type { LogEvent } from "../src/core/events.ts";

/**
 * Unit tests for the `advance` delivery-cursor reducer (M5.1).
 *
 * The reducer is pure: given the current cursor, the fold's delivery fields,
 * the events, and timing params, it returns the next cursor. The four
 * transitions tested here:
 *   1. First-pass adoption
 *   2. Unanswered-claim rollback
 *   3. Foreign-claim adoption
 *   4. Pending tracking
 */

const ack = (seq: number, covers: number, at = `${seq}`): LogEvent =>
  ({ t: "agent_ack", seq, at, id: `ack-${seq}`, covers }) as unknown as LogEvent;

const prompt = (seq: number): LogEvent =>
  ({ t: "prompt", seq, at: `${seq}`, id: `p-${seq}`, content: "hi" }) as unknown as LogEvent;

const fresh = (): DeliveryCursor => ({
  deliveredUpTo: undefined,
  firstPendingAt: undefined,
  ownClaimSeq: 0,
  unfulfilledClaimAt: undefined,
});

describe("advance - first-pass adoption", () => {
  test("adopts the fold's deliveredThroughSeq on the first pass", () => {
    const cursor = advance(fresh(), { deliveredThroughSeq: 5, agentWorking: null }, [], {
      now: 1000,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(cursor.deliveredUpTo).toBe(5);
  });

  test("does not re-adopt once deliveredUpTo is defined (no foreign claim)", () => {
    const before: DeliveryCursor = {
      deliveredUpTo: 5,
      firstPendingAt: undefined,
      ownClaimSeq: 0,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(before, { deliveredThroughSeq: 5, agentWorking: null }, [], {
      now: 1000,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(cursor.deliveredUpTo).toBe(5);
  });
});

describe("advance - foreign-claim adoption", () => {
  test("adopts a larger foreign deliveredThroughSeq", () => {
    const before: DeliveryCursor = {
      deliveredUpTo: 3,
      firstPendingAt: 100,
      ownClaimSeq: 0,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(before, { deliveredThroughSeq: 7, agentWorking: null }, [], {
      now: 1000,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(cursor.deliveredUpTo).toBe(7);
    expect(cursor.firstPendingAt).toBeUndefined();
  });

  test("does NOT adopt a foreign claim equal to our own outstanding claim", () => {
    const before: DeliveryCursor = {
      deliveredUpTo: 3,
      firstPendingAt: undefined,
      ownClaimSeq: 7,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(before, { deliveredThroughSeq: 7, agentWorking: null }, [], {
      now: 1000,
      workingGraceMs: 500,
      inFlight: false,
    });
    // ownClaimSeq(7) === deliveredThroughSeq(7) → foreign adoption skips
    expect(cursor.deliveredUpTo).toBe(3);
  });
});

describe("advance - unanswered-claim rollback", () => {
  test("rolls back a stale claim with no agent output", () => {
    // An ack at seq=5 covering 4, with no reply after it. The working window
    // is older than the grace. ownClaimSeq is 0 (not ours), deliveredUpTo
    // equals deliveredThroughSeq.
    const events = [prompt(1), ack(5, 4, "100")];
    const before: DeliveryCursor = {
      deliveredUpTo: 4,
      firstPendingAt: undefined,
      ownClaimSeq: 0,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(
      before,
      { deliveredThroughSeq: 4, agentWorking: { since: "100", heardAt: "100" } },
      events,
      {
        now: 10000, // far past the grace
        workingGraceMs: 500,
        inFlight: false,
      },
    );
    // priorMark = answeredMark(events) = 0 (no reply follows the ack)
    // 0 < 4 → rollback to 0
    expect(cursor.deliveredUpTo).toBe(0);
    expect(cursor.ownClaimSeq).toBe(4); // disowned: set to deliveredThroughSeq
    expect(cursor.unfulfilledClaimAt).toBeUndefined();
  });

  test("does NOT roll back when the turn is in flight", () => {
    const events = [prompt(1), ack(5, 4, "100")];
    const before: DeliveryCursor = {
      deliveredUpTo: 4,
      firstPendingAt: undefined,
      ownClaimSeq: 0,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(
      before,
      { deliveredThroughSeq: 4, agentWorking: { since: "100", heardAt: "100" } },
      events,
      {
        now: 10000,
        workingGraceMs: 500,
        inFlight: true, // our turn is running
      },
    );
    expect(cursor.deliveredUpTo).toBe(4); // no rollback
  });

  test("does NOT roll back when the claim is ours and still being judged", () => {
    const events = [prompt(1), ack(5, 4, "100")];
    const before: DeliveryCursor = {
      deliveredUpTo: 4,
      firstPendingAt: undefined,
      ownClaimSeq: 4, // OUR claim
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(
      before,
      { deliveredThroughSeq: 4, agentWorking: { since: "100", heardAt: "100" } },
      events,
      {
        now: 10000,
        workingGraceMs: 500,
        inFlight: false,
      },
    );
    // ownClaimSeq(4) === deliveredThroughSeq(4) → condition fails, no rollback
    expect(cursor.deliveredUpTo).toBe(4);
  });
});

describe("advance - pending tracking", () => {
  test("opens firstPendingAt on the first pending event", () => {
    const events = [prompt(1), prompt(3)]; // both pending (deliveredUpTo = 0)
    const cursor = advance(fresh(), { deliveredThroughSeq: 0, agentWorking: null }, events, {
      now: 5000,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(cursor.deliveredUpTo).toBe(0);
    expect(cursor.firstPendingAt).toBe(5000);
  });

  test("clears firstPendingAt when nothing is pending", () => {
    const events: LogEvent[] = []; // no pending events
    const before: DeliveryCursor = {
      deliveredUpTo: 5,
      firstPendingAt: 1000,
      ownClaimSeq: 0,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(before, { deliveredThroughSeq: 5, agentWorking: null }, events, {
      now: 2000,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(cursor.firstPendingAt).toBeUndefined();
  });

  test("preserves an existing firstPendingAt when still pending", () => {
    const events = [prompt(3)];
    const before: DeliveryCursor = {
      deliveredUpTo: 0,
      firstPendingAt: 1000,
      ownClaimSeq: 0,
      unfulfilledClaimAt: undefined,
    };
    const cursor = advance(before, { deliveredThroughSeq: 0, agentWorking: null }, events, {
      now: 2000,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(cursor.firstPendingAt).toBe(1000); // not overwritten
  });
});

describe("advance - overlap safety (M5.1 checkboxes)", () => {
  test("two concurrent passes cannot clobber ownClaimSeq to 0", () => {
    // The advance reducer never sets ownClaimSeq to 0: it only changes it in
    // the rollback path (sets it to deliveredThroughSeq). So interleaved
    // advance calls preserve a non-zero ownClaimSeq.
    const before: DeliveryCursor = {
      deliveredUpTo: 5,
      firstPendingAt: undefined,
      ownClaimSeq: 7,
      unfulfilledClaimAt: undefined,
    };
    // Two passes with the same inputs (simulating interleaved execution)
    const pass1 = advance(before, { deliveredThroughSeq: 7, agentWorking: null }, [], {
      now: 1000,
      workingGraceMs: 500,
      inFlight: false,
    });
    const pass2 = advance(pass1, { deliveredThroughSeq: 7, agentWorking: null }, [], {
      now: 1001,
      workingGraceMs: 500,
      inFlight: false,
    });
    expect(pass2.ownClaimSeq).toBe(7);
    expect(pass2.ownClaimSeq).not.toBe(0);
  });

  test("an orphan's claim is not re-adopted after the sweep", () => {
    // After the orphan sweep: deliveredUpTo = answeredMark (0), ownClaimSeq =
    // closedClaimMax (the swept claim). The next advance must NOT re-adopt
    // the swept claim via foreign-claim adoption, because
    // deliveredThroughSeq === ownClaimSeq.
    const afterSweep: DeliveryCursor = {
      deliveredUpTo: 0,
      firstPendingAt: undefined,
      ownClaimSeq: 5, // the swept claim's max
      unfulfilledClaimAt: undefined,
    };
    // The fold still carries deliveredThroughSeq=5 (the swept ack is in the log)
    const cursor = advance(afterSweep, { deliveredThroughSeq: 5, agentWorking: null }, [], {
      now: 1000,
      workingGraceMs: 500,
      inFlight: false,
    });
    // foreign-claim adoption skips: deliveredThroughSeq(5) !== ownClaimSeq(5) is FALSE
    expect(cursor.deliveredUpTo).toBe(0); // not re-adopted to 5
  });
});
