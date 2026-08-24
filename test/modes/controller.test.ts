import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAction } from "../../src/modes/controller.js";
import type { Frame } from "../../src/protocol/index.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { attach, event } from "../protocol/helpers.js";

/** A host rig whose clock and presence the test drives directly. */
const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-ctrl-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const box = { now: 1_000, presence: undefined as boolean | undefined };
  const host = openConversation(join(root, "conv-1"), {
    now: () => box.now,
    presence: () => box.presence,
    executorLease: () => false,
    onRecord: () => {},
    onEffect: () => {},
  });
  const send = (frame: Frame) => host.handleFrame(JSON.stringify(frame));
  return { root, secret, host, box, send };
};

describe("conversation controller + handoff (M5.4)", () => {
  test("the mode-selection state machine maps every channel state to its PLAN 4.6 action", () => {
    expect(decideAction("interactive-attached")).toMatchObject({ action: "deliver" });
    expect(decideAction("headless-session")).toMatchObject({ action: "deliver" });
    expect(decideAction("headless-turn")).toMatchObject({ action: "deliver-at-boundary" });
    // No pipe to a living-but-unattached human: wait for an authenticated
    // re-attach, never wake directly, never headless-takeover.
    expect(decideAction("interactive-unattached")).toMatchObject({
      action: "await-reattach",
      takeover: false,
    });
    // Process gone: headless takeover is the move.
    expect(decideAction("agent-gone")).toMatchObject({
      action: "headless-takeover",
      takeover: true,
    });
  });

  test("attached -> unattached is the heartbeat clock (presence alive), unattached -> gone is presence, gone -> headless takeover epoch++", () => {
    const r = rig();
    r.box.presence = true;
    r.send(attach({ conversationId: "conv-1", secret: r.secret }));
    expect(r.host.status()).toBe("interactive-attached");

    // Heartbeat grace passes; the human process is still alive: unattached.
    r.box.now = 1_000 + 15_000;
    expect(r.host.status()).toBe("interactive-unattached");
    expect(decideAction(r.host.status()).takeover).toBe(false); // presence holds

    // Process exits: gone -> headless takeover is now legal.
    r.box.presence = false;
    expect(r.host.status()).toBe("agent-gone");
    const takeover = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }),
    );
    expect(takeover.verdict).toBe("accepted");
    expect(r.host.state().epoch).toBe(2);
  });

  test("interactive reattach increments the epoch and fences the stale writer", () => {
    const r = rig();
    r.send(attach({ conversationId: "conv-1", secret: r.secret }));
    r.box.now = 1_000 + 15_000; // lease lapses
    const reattach = r.send(attach({ conversationId: "conv-1", secret: r.secret }));
    expect(reattach.verdict).toBe("accepted");
    expect(r.host.state().epoch).toBe(2);
    // The old epoch is fenced.
    const stale = r.send(event({ epoch: 1, n: 1 }));
    expect(stale.verdict).toBe("refused");
  });

  test("boundary-only handoff enforced: a mid-LEASE takeover is refused; a handoff is legal only after a clean detach or lease expiry (which aborts the in-flight turn)", () => {
    const r = rig();
    r.send(attach({ conversationId: "conv-1", secret: r.secret }));
    r.send(event({ epoch: 1, n: 1, turnId: "t-1" }));

    // While the lease is valid, a contender CANNOT seize the channel -
    // handoff is not legal mid-lease, only at the writer's own boundary or
    // after expiry.
    const blocked = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }),
    );
    expect(blocked.verdict).toBe("refused");
    if (blocked.verdict === "refused") expect(blocked.issue).toBe("lease-held");

    // Lease expiry: the takeover is the one legal mid-turn handoff, and it
    // ABORTS the in-flight turn (the new writer never drains it).
    r.box.now = 1_000 + 15_000;
    const forced = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }),
    );
    expect(forced.verdict).toBe("accepted");
    expect(r.host.transcript().aborted).toContain("t-1");
  });

  test("D-020 exactly-once handoff oracle: an event IN the replay window at handoff time - headless->interactive, resumeFrom scopes it exactly, survives reopen", () => {
    const r = rig();
    // Headless writer A (epoch 1) streams two events but the renderer only
    // durably applies + acks the FIRST. "two" is unacked and in flight at
    // handoff - the case that actually exercises the replay boundary.
    r.send(attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }));
    r.send(event({ epoch: 1, n: 1, turnId: "t-1", event: { kind: "message", text: "one" } }));
    const ackedThroughOne = r.host.state().seq;
    r.send({ kind: "ack", epoch: 1, covers: ackedThroughOne });
    r.send(event({ epoch: 1, n: 2, turnId: "t-1", event: { kind: "message", text: "two" } }));

    // A yields; interactive B resumes from what it durably applied (only
    // "one"). "two" is unacked and MUST replay; "one" MUST NOT.
    r.send({ kind: "detach", epoch: 1, reason: "yield" });
    const b = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, resumeFrom: ackedThroughOne }),
    );
    expect(b.verdict).toBe("accepted");
    if (b.verdict !== "accepted") return;
    const okFrame = b.effects.find((e) => e.type === "send" && e.frame.kind === "attach-ok");
    const replayFrom =
      okFrame && okFrame.type === "send" && okFrame.frame.kind === "attach-ok"
        ? okFrame.frame.replayFrom
        : -1;
    expect(replayFrom).toBe(ackedThroughOne);

    r.send(event({ epoch: 2, n: 1, turnId: "t-2", event: { kind: "message", text: "three" } }));

    const t = r.host.transcript();
    const seqs = t.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(t.events.map((e) => (e.event as { text: string }).text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(t.events.map((e) => e.epoch)).toEqual([1, 1, 2]);

    // The boundary is genuinely exercised: at handoff, replayFrom scoped
    // an event that WAS already durable ("two") into the replay window,
    // and excluded the applied one ("one") - exactly-once, no gap.
    const replayed = t.events
      .filter((e) => e.seq > replayFrom)
      .map((e) => (e.event as { text: string }).text);
    expect(replayed).toEqual(["two", "three"]);
    expect(replayed).not.toContain("one");

    // Crash-safe end to end: a reopened host folds the log to the IDENTICAL
    // transcript (events + aborted), so fold-replay and live-commit agree.
    r.host.close();
    const reopened = openConversation(join(r.root, "conv-1"), {
      now: () => r.box.now,
      presence: () => r.box.presence,
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    expect(reopened.transcript()).toEqual(t);
  });

  test("D-020 the other direction: interactive->headless mid-turn, exactly-once holds and the aborted turn is reconstructed by fold", () => {
    const r = rig();
    r.send(attach({ conversationId: "conv-1", secret: r.secret, profile: "interactive" }));
    r.send(event({ epoch: 1, n: 1, turnId: "t-1", event: { kind: "message", text: "human" } }));
    // Lease expires mid-turn (no detach): a headless takeover ABORTS t-1.
    r.box.now = 1_000 + 15_000;
    const takeover = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }),
    );
    expect(takeover.verdict).toBe("accepted");
    r.send(event({ epoch: 2, n: 1, turnId: "t-2", event: { kind: "message", text: "agent" } }));

    const t = r.host.transcript();
    expect(t.events.map((e) => (e.event as { text: string }).text)).toEqual(["human", "agent"]);
    expect(t.aborted).toContain("t-1"); // the interrupted turn is flagged

    // Fold reconstructs the SAME transcript incl. the aborted turn - the
    // fold branch of collectTranscript agrees with live-commit.
    r.host.close();
    const reopened = openConversation(join(r.root, "conv-1"), {
      now: () => r.box.now,
      presence: () => r.box.presence,
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    expect(reopened.transcript()).toEqual(t);
  });
});
