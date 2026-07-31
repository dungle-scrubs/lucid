import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approveBlockedReason,
  deliveredWaiting,
  type AwaitPresence,
} from "../client/chrome/store.ts";

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

/**
 * Which sends open the delivered-waiting window (finding #19).
 *
 * The line exists to fill the gap between a send landing and the agent
 * speaking - a gap that is 3-4s for a headless turn (attend's 3s debounce plus
 * a poll). It renders on `awaitingAck`, which the ANNOTATION path set and the
 * message path did not: marking up text showed "Delivered - starting a turn…",
 * typing in the composer showed nothing at all.
 */
describe("every send that lands opens the window, not just annotations", () => {
  const SOURCE = readFileSync(join(import.meta.dir, "..", "client/chrome/actions.ts"), "utf8");

  test("the outbox drain sets awaitingAck once a message really landed", () => {
    // Asserted on the source because the drain is a network loop over module
    // state; what matters is that the successful-post branch - the one that
    // discards the message from the outbox - is also the one that opens the
    // window. A post that threw must NOT (it warns and keeps the text).
    const drain = /const flushOutbox[\s\S]*?\n {2}};/.exec(SOURCE)?.[0] ?? "";
    expect(drain, "could not find flushOutbox").not.toBe("");
    // Holds the id of the send it is waiting on, not a bare flag: as a boolean
    // it could not say WHICH send it covered (plan 08 M8).
    expect(drain).toContain("awaitingAck: new Set(");
    // ORDER, not proximity: it must come after the discard that marks the
    // post as landed, so it cannot be hoisted above the try and claim a send
    // that never happened. (A distance check would have measured how long the
    // comment beside it is.)
    const discardAt = drain.indexOf("discardOutboxMessage");
    const openAt = drain.indexOf("awaitingAck: new Set(");
    expect(discardAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(discardAt);
  });

  test("a failed post does not claim the agent has anything to answer", () => {
    const drain = /const flushOutbox[\s\S]*?\n {2}};/.exec(SOURCE)?.[0] ?? "";
    const catchBlock = /\} catch \(e\) \{[\s\S]*?\n {8}\}/.exec(drain)?.[0] ?? "";
    expect(catchBlock, "could not find the drain's catch").not.toBe("");
    expect(catchBlock).not.toContain("awaitingAck");
  });
});

/**
 * Why Approve is refused (user report: the button "seems to not do anything").
 *
 * One function, because the tooltip and the click's warning are the same
 * sentence and had two implementations - the header computed a specific reason
 * while the action warned generically, so the click could not tell you the
 * thing the hover already knew.
 */
describe("approveBlockedReason names the thing that is unfinished", () => {
  const none = { queued: 0, hasDraft: false, undelivered: 0 };

  test("nothing unfinished, no reason", () => {
    expect(approveBlockedReason(none)).toBeNull();
  });

  test("an undelivered message wins - it is the one that can be lost", () => {
    expect(approveBlockedReason({ ...none, undelivered: 2, queued: 1, hasDraft: true })).toContain(
      "2 undelivered messages",
    );
  });

  test("queued annotations, counted", () => {
    expect(approveBlockedReason({ ...none, queued: 1 })).toContain("1 queued annotation");
    expect(approveBlockedReason({ ...none, queued: 3 })).toContain("3 queued annotations");
  });

  test("a draft says so - the case with no card of its own anywhere else", () => {
    expect(approveBlockedReason({ ...none, hasDraft: true })).toContain("draft annotation");
  });
});

/**
 * The two defects a bare boolean could not distinguish (plan 08 M8, D-006).
 *
 * `clearDelivered` is the seam: it takes the ids a send is waiting on and the
 * payload, and returns what is still outstanding. Testing it directly rather
 * than through the store keeps the assertion on the RULE - "clear what the
 * server says is delivered" - instead of on the plumbing around it.
 */
describe("awaitingAck holds the ids of the send it covers", () => {
  const SURFACE = readFileSync(join(import.meta.dir, "..", "client/chrome/surface.ts"), "utf8");

  test("it clears against the payload's delivered state, not against a working window", () => {
    // 07#21: any open working window cleared the boolean, so typing while the
    // agent was mid-turn on an EARLIER batch reopened the 3-4s silence #92
    // closed. The clear must not read agentWorking at all.
    const fn = /const clearDelivered[\s\S]*?\n};/.exec(SURFACE)?.[0] ?? "";
    expect(fn, "could not find clearDelivered").not.toBe("");
    expect(fn).not.toContain("agentWorking");
    expect(fn).toContain("delivered");
  });

  test("an id the payload has not mentioned yet is kept, not dropped", () => {
    // The other direction: clearing on absence would blank the line before the
    // agent had seen anything, which is the same lie in reverse.
    const fn = /const clearDelivered[\s\S]*?\n};/.exec(SURFACE)?.[0] ?? "";
    expect(fn).toContain("filter");
    expect(fn).toContain("!delivered.has(id)");
  });

  test("both send paths carry ids into it", () => {
    // 07#22 needs the message path to participate: a deduped message whose
    // item is ALREADY delivered must resolve at once rather than wait for an
    // ack that will never come. That only works if messages are in the set.
    const actions = readFileSync(join(import.meta.dir, "..", "client/chrome/actions.ts"), "utf8");
    const sends = actions.match(/awaitingAck: new Set\(/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });
});
