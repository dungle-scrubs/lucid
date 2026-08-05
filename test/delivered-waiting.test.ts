import { describe, expect, test } from "bun:test";
import { createSession } from "../client/chrome/session.ts";
import { clearDelivered } from "../client/chrome/surface.ts";
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
import type { StateResponse } from "../src/protocol/wire.ts";

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

/** A spot a queued annotation points at, shared by the queue and send tests. */
const anchor: Anchor = {
  kind: "element",
  fingerprint: 'li#a3f9·"Backfill"',
  domPath: "ol>li:nth-child(1)",
  snippet: "<li>Backfill</li>",
};

/**
 * A session handle with no server behind it, and a stub answering the routes a
 * send or a version swap reads. `base` is absolute so the chrome's one fetch
 * seam addresses the stub rather than a page origin that does not exist.
 *
 * `failMessage` makes the outbox drain's POST throw (a 4xx is the server's
 * verdict, so the transport refuses at once rather than retrying for 14s): the
 * success path answers every route, the failure path answers everything EXCEPT
 * the message post.
 */
const V2 = "<!doctype html><html><body><h1>v2</h1></body></html>";

const withStub = async (
  key: string,
  body: (handle: ReturnType<typeof createSession>) => Promise<void>,
  opts: { failMessage?: boolean } = {},
): Promise<void> => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/__lucid/artifact")) return new Response(V2);
    // A 4xx is the server's VERDICT, not a blip: the transport throws at once
    // (no backoff) carrying the server's own words, which is the real failure
    // shape the drain must keep the text through.
    if (opts.failMessage && method === "POST" && url.endsWith("/__lucid/message")) {
      return new Response(JSON.stringify({ error: "log busy" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
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
 * Which sends open the delivered-waiting window (finding #19), driven through
 * the handle rather than read off the source.
 *
 * The line exists to fill the gap between a send landing and the agent
 * speaking - a gap that is 3-4s for a headless turn (attend's 3s debounce plus
 * a poll). It renders on `awaitingAck`, which the ANNOTATION path set and the
 * message path did not: marking up text showed "Delivered - starting a turn…",
 * typing in the composer showed nothing at all. The two defects a bare boolean
 * could not distinguish (07#22) are covered here too: both sends must land
 * their ids, and a post that threw must not.
 */
describe("every send that lands opens the window, not just annotations", () => {
  const unsent: OutboxMessage = { id: "m1", text: "hold this", images: [], at: "t", failed: false };
  const queued: QueuedAnnotation = {
    id: "q1",
    target: anchor,
    targets: [anchor],
    note: "n",
    at: "t",
    images: [],
  };

  test("a successful post opens the window on the message that landed", async () => {
    // The message really landed, so awaitingAck holds ITS id (D-054 / finding
    // #19). Asserted on the drain's observable consequence - the id is in the
    // set AND the message has left the outbox - which is what the
    // discard-before-open ordering guards: the set is written AFTER the
    // discard, never hoisted above the post.
    await withStub("/proj/.lucid/drain-ok.html", async (handle) => {
      handle.store.setState({ outbox: [unsent] });
      await handle.actions.flushOutbox();
      expect(handle.store.getState().awaitingAck).toEqual(new Set(["m1"]));
      expect(handle.store.getState().outbox).toEqual([]);
    });
  });

  test("a failed post does not claim the agent has anything to answer", async () => {
    // The catch keeps the text and its own warning; awaitingAck stays clear
    // because nothing landed. This covers the discard-before-open ordering by
    // its observable consequence: a post that threw must not open the window,
    // and its message must stay put, marked failed, text intact.
    await withStub(
      "/proj/.lucid/drain-fail.html",
      async (handle) => {
        handle.store.setState({ outbox: [unsent] });
        await handle.actions.flushOutbox();
        expect(handle.store.getState().awaitingAck).toBeNull();
        const out = handle.store.getState().outbox;
        expect(out).toHaveLength(1);
        expect(out[0]?.failed).toBe(true);
        expect(out[0]?.text).toBe(unsent.text);
      },
      { failMessage: true },
    );
  });

  test("an empty outbox drains to nothing and opens no window", async () => {
    // SHOULD: the drain's re-entrancy guard returns before any post, so an empty
    // outbox neither sends nor opens the window.
    await withStub("/proj/.lucid/drain-empty.html", async (handle) => {
      await handle.actions.flushOutbox();
      expect(handle.store.getState().awaitingAck).toBeNull();
      expect(handle.store.getState().outbox).toEqual([]);
    });
  });

  test("the annotation send path lands its id in awaitingAck too (07#22)", async () => {
    // 07#22 needs BOTH send paths to participate: a deduped message whose item
    // is ALREADY delivered must resolve at once rather than wait for an ack
    // that will never come. The message path is covered by the drain test
    // above; this drives the annotation path through the same handle so the
    // pair is provably symmetric - every send that lands opens the window.
    await withStub("/proj/.lucid/send-annot.html", async (handle) => {
      handle.store.setState({ queue: [queued] });
      await handle.actions.sendQueue();
      expect(handle.store.getState().awaitingAck).toEqual(new Set(["q1"]));
      expect(handle.store.getState().queue).toEqual([]);
    });
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
  const unsent: OutboxMessage = { id: "m1", text: "hold this", images: [], at: "t", failed: false };

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
 * The two defects a bare boolean could not distinguish (plan 08 M8, D-006),
 * asserted on the RULE rather than the plumbing around it.
 *
 * `clearDelivered` is the seam: it takes the ids a send is waiting on and the
 * payload, and returns what is still outstanding. Called directly here so the
 * assertion stays on the rule - "clear what the server says is delivered, keep
 * what it has not mentioned" - instead of on the store wiring around it.
 */
describe("awaitingAck holds the ids of the send it covers", () => {
  /** A StateResponse carrying only the fields clearDelivered reads; the rest
   *  are out of scope for this rule. */
  const payload = (over: {
    annotations?: { id: string; delivered?: true }[];
    messages?: { id: string; delivered?: true }[];
    agentWorking?: unknown;
  }): StateResponse =>
    ({
      annotations: [],
      messages: [],
      ...over,
    }) as unknown as StateResponse;

  test("it clears against the payload's delivered state, not against a working window (07#21)", () => {
    // 07#21: any open working window cleared the boolean, so typing while the
    // agent was mid-turn on an EARLIER batch reopened the 3-4s silence #92
    // closed. The clear must read the payload's delivered state and nothing
    // else - so a window being open changes nothing about an undelivered id.
    const waiting = new Set(["a1", "a2"]);
    const p = payload({
      agentWorking: { since: "t" }, // a window IS open - 07#21's trap
      annotations: [{ id: "a1", delivered: true }, { id: "a2" }],
    });
    expect(clearDelivered(waiting, p)).toEqual(new Set(["a2"]));
  });

  test("a delivered message id clears too (07#22)", () => {
    // The message path lands ids in awaitingAck (the drain test above), so a
    // delivered message must resolve the same way an annotation does.
    const waiting = new Set(["m1", "m2"]);
    const p = payload({ messages: [{ id: "m1", delivered: true }, { id: "m2" }] });
    expect(clearDelivered(waiting, p)).toEqual(new Set(["m2"]));
  });

  test("an id the payload has not mentioned yet is kept, not dropped", () => {
    // The other direction: clearing on absence would blank the line before the
    // agent had seen anything, which is the same lie in reverse. A send whose
    // item has not appeared in the fold yet is still outstanding.
    expect(clearDelivered(new Set(["x9"]), payload({}))).toEqual(new Set(["x9"]));
  });

  test("nothing left to wait on resolves to null", () => {
    expect(
      clearDelivered(new Set(["a1"]), payload({ annotations: [{ id: "a1", delivered: true }] })),
    ).toBeNull();
    expect(clearDelivered(null, payload({}))).toBeNull();
    expect(clearDelivered(new Set(), payload({}))).toBeNull();
  });
});
