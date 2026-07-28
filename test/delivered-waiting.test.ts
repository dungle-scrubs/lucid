import { describe, expect, test } from "bun:test";
import { deliveredWaiting, type AwaitPresence } from "../client/chrome/store.ts";

/**
 * The line shown between a feedback send and the agent's first ack.
 *
 * The gap it fills: an annotation is in the log, but `agentWorking` has not
 * opened yet, so the log has nothing new and the UI would otherwise go silent
 * for the couple of seconds the agent spends waking, reading, and declaring
 * intent. The rule that matters is that the line only PROMISES a response when
 * one is coming - `transient` (a shimmer) for the three attended cases, a
 * standing muted fact for the unattended one.
 */

const presence = (over: Partial<AwaitPresence> = {}): AwaitPresence => ({
  interactive: false,
  listening: 0,
  spawnable: false,
  harness: "claude-code",
  ...over,
});

describe("delivered, waiting for the agent", () => {
  test("a human at the terminal is told delivery reached them", () => {
    // They will switch to their own terminal; the response is coming, so it is
    // transient - and it names the harness, because "the terminal" is theirs.
    expect(deliveredWaiting(presence({ interactive: true }))).toEqual({
      text: "Delivered to claude-code in the terminal",
      transient: true,
    });
  });

  test("an agent blocked in wait means an imminent pickup", () => {
    expect(deliveredWaiting(presence({ listening: 2 }))).toEqual({
      text: "Delivered — waiting for the agent…",
      transient: true,
    });
  });

  test("spawn mode promises the hub will start a turn", () => {
    expect(deliveredWaiting(presence({ spawnable: true }))).toEqual({
      text: "Delivered — starting a turn…",
      transient: true,
    });
  });

  test("nothing attending is a standing fact, not a wait", () => {
    // The one line that is NOT transient: no shimmer, because there is nothing
    // to shimmer for. This is the honest replacement for a spinner that would
    // otherwise imply a response nobody is going to send.
    expect(deliveredWaiting(presence())).toEqual({
      text: "Delivered — nothing is watching yet",
      transient: false,
    });
  });

  test("interactive outranks a listening count", () => {
    // A human mid-thought reads zero listeners (the agent is not blocked in
    // wait), so the interactive signal must win or the line would claim the
    // wrong recipient.
    expect(deliveredWaiting(presence({ interactive: true, listening: 0 })).text).toContain(
      "the terminal",
    );
  });

  test("listening outranks spawnable", () => {
    // A connected waiter is a stronger promise than a resume the hub has not
    // started yet.
    expect(deliveredWaiting(presence({ listening: 1, spawnable: true })).text).toBe(
      "Delivered — waiting for the agent…",
    );
  });
});
