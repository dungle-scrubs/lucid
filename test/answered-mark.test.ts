import { describe, expect, test } from "bun:test";
import { answeredMark } from "../src/core/fold.ts";
import type { LogEvent } from "../src/core/events.ts";

/**
 * Unit tests for `answeredMark` (M5.1), extracted from attend.ts to fold.ts.
 *
 * The function computes the highest delivery mark FOLLOWED by agent output -
 * a batch some turn actually answered, not merely claimed. This is what a
 * stale claim rolls back to: delivery is acked before the turn runs (D20),
 * so an ack alone proves nothing about whether the work happened.
 */

const ack = (seq: number, covers: number): LogEvent =>
  ({ t: "agent_ack", seq, at: `${seq}`, id: `ack-${seq}`, covers }) as unknown as LogEvent;

const reply = (seq: number): LogEvent =>
  ({
    t: "agent_reply",
    seq,
    at: `${seq}`,
    id: `reply-${seq}`,
    content: "ok",
  }) as unknown as LogEvent;

const version = (seq: number): LogEvent =>
  ({ t: "version", seq, at: `${seq}`, id: `v-${seq}`, ref: "abc", n: 1 }) as unknown as LogEvent;

const question = (seq: number): LogEvent =>
  ({
    t: "question",
    seq,
    at: `${seq}`,
    id: `q-${seq}`,
    anchor: { sel: "x", char: 0 },
  }) as unknown as LogEvent;

const feedback = (seq: number): LogEvent =>
  ({ t: "prompt", seq, at: `${seq}`, id: `p-${seq}`, content: "hi" }) as unknown as LogEvent;

describe("answeredMark", () => {
  test("returns 0 for an empty log", () => {
    expect(answeredMark([])).toBe(0);
  });

  test("returns 0 when no ack was followed by agent output", () => {
    // An ack with no reply/version/question after it is an unfulfilled claim
    expect(answeredMark([ack(5, 3), feedback(4)])).toBe(0);
  });

  test("returns the ack's covers when followed by a reply", () => {
    expect(answeredMark([ack(5, 3), reply(6)])).toBe(3);
  });

  test("returns the ack's covers when followed by a version", () => {
    expect(answeredMark([ack(5, 3), version(6)])).toBe(3);
  });

  test("returns the ack's covers when followed by a question", () => {
    expect(answeredMark([ack(5, 3), question(6)])).toBe(3);
  });

  test("takes the MAX across multiple answered batches", () => {
    expect(answeredMark([ack(2, 1), reply(3), ack(5, 4), version(6)])).toBe(4);
  });

  test("ignores agent output that has no preceding ack (no open mark)", () => {
    // A reply with no ack before it has no mark to close
    expect(answeredMark([reply(1), ack(3, 2), reply(4)])).toBe(2);
  });

  test("a later ack without output does not advance the answered mark", () => {
    // First batch answered at covers=3, then a new claim at covers=7 with no output
    expect(answeredMark([ack(2, 3), reply(4), ack(6, 7)])).toBe(3);
  });

  test("a re-ack (progress update) does not reset the open mark to a lower value", () => {
    // ack covers=5, then a re-ack with no covers field - openMark stays at 5
    expect(answeredMark([ack(2, 5), ack(3, undefined as unknown as number), reply(4)])).toBe(5);
  });
});
