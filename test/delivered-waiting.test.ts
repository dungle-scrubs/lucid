import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSession } from "../client/chrome/session.ts";
import {
  approveBlockedReason,
  blocksVersionSwap,
  deliveredWaiting,
  sessionSwitchBlockedReason,
  unsentWork,
  versionSwapBlockedReason,
  type AwaitPresence,
} from "../client/chrome/store.ts";
import type { OutboxMessage, QueuedAnnotation } from "../client/chrome/types.ts";
import type { Anchor } from "../src/anchors/anchor.ts";

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
 * What counts as unsent work, asked once (#15).
 *
 * Seven gates asked the question and five answered it inline, so the answers
 * disagreed: Approve counted the outbox, the deferred version swap and the
 * session switch did not. `unsentWork` is the membership; every gate now reads
 * it, and the two that used to walk over an undelivered message no longer can.
 */
describe("the session holds unsent work, counted in one place", () => {
  const state = (over: Partial<Parameters<typeof unsentWork>[0]> = {}) =>
    unsentWork({ queue: [], pendingTarget: null, composerNote: "", outbox: [], ...over });

  const anchor: Anchor = {
    kind: "element",
    fingerprint: 'li#a3f9·"Backfill"',
    domPath: "ol>li:nth-child(1)",
    snippet: "<li>Backfill</li>",
  };
  const queued: QueuedAnnotation = {
    id: "q1",
    target: anchor,
    targets: [anchor],
    note: "n",
    at: "t",
    images: [],
  };
  const unsent: OutboxMessage = { id: "m1", text: "hi", images: [], at: "t", failed: false };

  test("the three kinds, off one state", () => {
    expect(state()).toEqual({ queued: 0, hasDraft: false, undelivered: 0 });
    expect(
      state({ queue: [queued], pendingTarget: anchor, composerNote: " x ", outbox: [unsent] }),
    ).toEqual({ queued: 1, hasDraft: true, undelivered: 1 });
  });

  test("a pick with only whitespace typed on it is not a draft", () => {
    expect(state({ pendingTarget: anchor, composerNote: "   " }).hasDraft).toBe(false);
  });

  test("an undelivered message holds the version swap - the membership it used to be left out of", () => {
    // The decided change (#15): the deferred swap counted the queue and the
    // draft and walked over the outbox, so a new version replaced the DOM a
    // message was still waiting to be sent against.
    expect(blocksVersionSwap(state({ outbox: [unsent] }))).toBe(true);
    expect(blocksVersionSwap(state({ queue: [queued] }))).toBe(true);
    expect(blocksVersionSwap(state({ pendingTarget: anchor, composerNote: "x" }))).toBe(true);
    expect(blocksVersionSwap(state())).toBe(false);
  });

  test("the banner's sentence names the act that actually frees the swap", () => {
    // The queue is not discardable and the outbox is not sendable from here,
    // so each clause asks for the thing that can be done to it.
    expect(versionSwapBlockedReason(state({ queue: [queued] }))).toBe(
      "send your 1 queued annotation to see it",
    );
    expect(
      versionSwapBlockedReason(
        state({ queue: [queued], pendingTarget: anchor, composerNote: "x" }),
      ),
    ).toBe("send your 1 queued annotation to see it, or discard your draft");
    expect(versionSwapBlockedReason(state({ pendingTarget: anchor, composerNote: "x" }))).toBe(
      "send or discard your draft",
    );
    expect(versionSwapBlockedReason(state({ outbox: [unsent] }))).toBe(
      "retry or discard your 1 undelivered message to see it",
    );
    expect(versionSwapBlockedReason(state())).toBeNull();
  });

  test("the switch's sentence names what would be left behind, in its own voice", () => {
    // Suffixing the approve wording produced "Retry or discard your 1
    // undelivered message first - a switch would leave it behind": the act
    // asked to come "first" before the thing it precedes was named. This gate
    // states the loss, then the act that avoids it.
    expect(sessionSwitchBlockedReason(state({ outbox: [unsent] }))).toBe(
      "Your 1 undelivered message would be left behind - retry or discard it before switching.",
    );
    expect(sessionSwitchBlockedReason(state({ queue: [queued, { ...queued, id: "q2" }] }))).toBe(
      "Your 2 queued annotations would be left behind - send or remove them before switching.",
    );
    expect(sessionSwitchBlockedReason(state({ pendingTarget: anchor, composerNote: "x" }))).toBe(
      "Your draft annotation would be left behind - queue or discard it before switching.",
    );
    expect(sessionSwitchBlockedReason(state())).toBeNull();
  });
});

/**
 * The same membership, at the two gates that used to disagree with it.
 *
 * Driven through a real session handle rather than the pure functions above:
 * what is being pinned is that the GATE asks the owner - a swap deferred by an
 * undelivered message, and released when that message leaves the outbox.
 */
describe("the gates that started counting the outbox", () => {
  const V2 = "<!doctype html><html><body><h1>v2</h1></body></html>";
  const unsent: OutboxMessage = { id: "m1", text: "hold this", images: [], at: "t", failed: false };

  /** A session handle with no server behind it, and a stub answering the two
   *  routes a version swap reads. `base` is absolute so the chrome's one fetch
   *  seam addresses the stub rather than a page origin that does not exist. */
  const withStub = async (
    key: string,
    body: (handle: ReturnType<typeof createSession>) => Promise<void>,
  ): Promise<void> => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/__lucid/artifact")) return new Response(V2);
      return new Response(
        JSON.stringify({
          session: key,
          version: 2,
          reviewResolved: false,
          annotations: [],
          messages: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const handle = createSession({
      session: key,
      name: "plan.html",
      version: 1,
      base: "http://127.0.0.1:1",
    });
    try {
      await body(handle);
    } finally {
      handle.surface.dispose();
      globalThis.fetch = real;
    }
  };

  test("a new version waits for an undelivered message, and lands when it leaves", async () => {
    await withStub("/proj/.lucid/swap.html", async (handle) => {
      handle.store.setState({ outbox: [unsent] });
      await handle.surface.onNewVersion(2);
      // Deferred: the tab still stamps annotations with v1 and says so.
      expect(handle.store.getState().newerVersion).toBe(2);
      expect(handle.store.getState().version).toBe(1);

      // Discarding the card is the outbox's own exit, so the swap it was
      // holding lands without any other gesture.
      handle.actions.discardOutboxMessage("m1");
      expect(handle.store.getState().version).toBe(2);
      expect(handle.store.getState().newerVersion).toBeNull();
      await new Promise((r) => setTimeout(r, 0)); // let the swap's re-bootstrap settle
    });
  });

  test("a session switch refuses over an undelivered message, and names it", async () => {
    await withStub("/proj/.lucid/switch.html", async (handle) => {
      handle.store.setState({ outbox: [unsent] });
      // `viewer` is empty so a regression cannot navigate the test runner: the
      // refusal has to be the warning, not the missing URL.
      handle.actions.switchToSession({
        session: "/proj/.lucid/other.html",
        name: "other.html",
        status: "active",
        version: 1,
        segment: 1,
        annotations: 0,
        live: true,
        viewer: "",
      });
      const warnings = handle.store.getState().warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain("1 undelivered message");
    });
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
