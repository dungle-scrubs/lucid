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

  test("D-020 exactly-once handoff oracle: headless->interactive with tokens in flight - the event transcript is ordered, gap-free, each event once, and the new writer resumes from acks not the wire", () => {
    const r = rig();
    // Headless writer A (epoch 1) streams a turn's worth of events.
    r.send(attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }));
    r.send(event({ epoch: 1, n: 1, turnId: "t-1", event: { kind: "message", text: "one" } }));
    r.send(event({ epoch: 1, n: 2, turnId: "t-1", event: { kind: "message", text: "two" } }));
    // A renderer durably applied through the second event's seq and acks it.
    const appliedThrough = r.host.state().seq;
    r.send({ kind: "ack", epoch: 1, covers: appliedThrough });

    // A yields at the boundary; interactive writer B takes over, resuming
    // from what it durably applied (the acked seq).
    r.send({ kind: "detach", epoch: 1, reason: "yield" });
    const b = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, resumeFrom: appliedThrough }),
    );
    expect(b.verdict).toBe("accepted");
    if (b.verdict !== "accepted") return;
    // attach-ok tells B exactly where to resume the render: after the ack.
    const okFrame = b.effects.find((e) => e.type === "send" && e.frame.kind === "attach-ok");
    expect(
      okFrame &&
        okFrame.type === "send" &&
        okFrame.frame.kind === "attach-ok" &&
        okFrame.frame.replayFrom,
    ).toBe(appliedThrough);

    // B (epoch 2) streams the rest of the conversation.
    r.send(event({ epoch: 2, n: 1, turnId: "t-2", event: { kind: "message", text: "three" } }));

    // The durable transcript across BOTH writers is one strictly-ordered
    // seq stream with each event applied exactly once. (Seqs are NOT
    // contiguous - ack/detach/attach consume seqs too, the sparse seq
    // space of D-028 - but they are strictly increasing and unique, which
    // is what "ordered, exactly-once" means for the render.)
    const t = r.host.transcript();
    const seqs = t.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1); // strictly increasing
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate application
    expect(t.events.map((e) => (e.event as { text: string }).text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    // The handoff crossed an epoch mid-stream, yet the render order is
    // seamless: epochs 1,1,2 in one ordered event stream.
    expect(t.events.map((e) => e.epoch)).toEqual([1, 1, 2]);

    // Exactly-once render on the handoff: B replays only what it had not
    // applied (seq > resumeFrom), so "one"/"two" are never re-rendered.
    const toReplay = t.events.filter((e) => e.seq > appliedThrough);
    expect(toReplay.map((e) => (e.event as { text: string }).text)).toEqual(["three"]);
  });
});
