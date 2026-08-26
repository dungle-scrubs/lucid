import { describe, expect, test } from "bun:test";
import {
  type Activity,
  describeActivity,
  formatElapsed,
  TURN_STALL_AFTER,
  UNDELIVERED_STALL_AFTER,
} from "../../src/server/client/activity.js";

const idle: Activity = { turn: false, inFlight: 0, waiting: 0 };
/** What the record shows mid-revision: the input is delivered and its turn
 * has not terminated, and the transcript has no line from it yet. */
const revising: Activity = { turn: false, inFlight: 1, waiting: 0 };
const running: Activity = { turn: true, inFlight: 1, waiting: 0 };
const undelivered: Activity = { turn: false, inFlight: 0, waiting: 3 };

describe("what the dock says", () => {
  test("says nothing when nothing is happening", () => {
    const r = describeActivity(idle, 9_999);
    expect(r.busy).toBe(false);
    expect(r.stalled).toBe(false);
    expect(r.elapsed).toBeNull();
  });

  test("a revision at the length actually measured is not an alarm", () => {
    // 127s is the slowest revision measured on this record. The page used to
    // call it stalled at 45s, on every single one.
    for (const a of [revising, running]) {
      const r = describeActivity(a, 127);
      expect(r.busy).toBe(true);
      expect(r.stalled).toBe(false);
      // Still says how long, so a long wait is legible without being an alarm.
      expect(r.elapsed).toBe("2m 7s");
    }
  });

  test("a running turn is an alarm only well past the slowest work seen", () => {
    expect(describeActivity(running, TURN_STALL_AFTER).stalled).toBe(false);
    expect(describeActivity(running, TURN_STALL_AFTER + 1).stalled).toBe(true);
    // And an in-flight input counts as the turn it is, not as an idle page.
    expect(describeActivity(revising, TURN_STALL_AFTER + 1).stalled).toBe(true);
  });

  test("notes nobody took are an alarm much sooner", () => {
    expect(describeActivity(undelivered, UNDELIVERED_STALL_AFTER).stalled).toBe(false);
    expect(describeActivity(undelivered, UNDELIVERED_STALL_AFTER + 1).stalled).toBe(true);
    expect(describeActivity(undelivered, UNDELIVERED_STALL_AFTER + 1).label).toBe(
      "3 written, not delivered yet",
    );
  });

  test("the two thresholds are not the same number", () => {
    // The whole defect was judging a slow turn and an undelivered note
    // against one threshold. If these ever converge, that is back.
    expect(TURN_STALL_AFTER).toBeGreaterThan(UNDELIVERED_STALL_AFTER);
  });

  test("a short wait shows no count", () => {
    expect(describeActivity(running, 3).elapsed).toBeNull();
    expect(describeActivity(running, 3).busy).toBe(true);
  });

  test("what is happening is named before it is timed", () => {
    expect(describeActivity(running, 1).label).toBe("the agent is working");
    expect(describeActivity(revising, 1).label).toBe("1 sent, waiting for the agent");
  });
});

describe("formatElapsed", () => {
  test("seconds until they stop reading as a number you can judge", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(44.4)).toBe("44s");
    expect(formatElapsed(89)).toBe("89s");
    expect(formatElapsed(90)).toBe("1m 30s");
    expect(formatElapsed(120)).toBe("2m");
    expect(formatElapsed(127)).toBe("2m 7s");
  });

  test("never counts backwards", () => {
    // The clock is a subtraction of two client timestamps, and a clock that
    // steps back would render "-3s".
    expect(formatElapsed(-5)).toBe("0s");
  });
});
