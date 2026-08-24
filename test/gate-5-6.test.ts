import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAction } from "../src/modes/controller.js";
import type { Frame } from "../src/protocol/index.js";
import { createConversationRecord, openConversation } from "../src/store/store.js";
import { attach, event } from "./protocol/helpers.js";

/**
 * Gate 5→6, criterion 1: one durable conversation carried across ALL THREE
 * modes with two mid-conversation handoffs, proving exactly-once render
 * end to end. Criteria 2 (live claude rung-1) and 3 (bare-session rungs
 * 2-3) are the live-smoke / A-003-gated items the gate marks waivable;
 * they live in DF-1/DF-3 with spike A-002 as the standing proof.
 */
describe("Gate 5→6: end-to-end fake-harness conversation across all three modes", () => {
  test("interactive -> headless-session -> headless-turn, two handoffs, exactly-once ordered render throughout", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-gate56-"));
    const { secret } = createConversationRecord(root, "conv-1");
    const box = { now: 1_000, presence: undefined as boolean | undefined };
    const host = openConversation(join(root, "conv-1"), {
      now: () => box.now,
      presence: () => box.presence,
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    const send = (f: Frame) => host.handleFrame(JSON.stringify(f));
    const GRACE = 15_000;

    // --- Mode 1: interactive attaches, a human turn streams (epoch 1).
    box.presence = true;
    send(attach({ conversationId: "conv-1", secret, profile: "interactive" }));
    expect(decideAction(host.status()).action).toBe("deliver");
    send(event({ epoch: 1, n: 1, turnId: "t-1", event: { kind: "message", text: "human turn" } }));
    // The renderer applies and acks through here.
    const acked1 = host.state().seq;
    send({ kind: "ack", epoch: 1, covers: acked1 });

    // --- Handoff 1: the human process exits; presence corroborates gone,
    // so the controller calls for a headless takeover (epoch 2).
    box.now += GRACE;
    box.presence = false;
    expect(host.status()).toBe("agent-gone");
    expect(decideAction(host.status())).toMatchObject({
      action: "headless-takeover",
      takeover: true,
    });
    const h2 = send(
      attach({ conversationId: "conv-1", secret, profile: "headless-session", resumeFrom: acked1 }),
    );
    expect(h2.verdict).toBe("accepted");
    expect(host.state().epoch).toBe(2);
    send(
      event({ epoch: 2, n: 1, turnId: "t-2", event: { kind: "message", text: "session turn" } }),
    );
    const acked2 = host.state().seq;
    send({ kind: "ack", epoch: 2, covers: acked2 });

    // --- Handoff 2: the session yields at its boundary; a per-turn
    // headless writer takes over (epoch 3) and runs a queued turn.
    send({ kind: "detach", epoch: 2, reason: "yield" });
    box.now += GRACE;
    const h3 = send(
      attach({ conversationId: "conv-1", secret, profile: "headless-turn", resumeFrom: acked2 }),
    );
    expect(h3.verdict).toBe("accepted");
    expect(host.state().epoch).toBe(3);
    expect(decideAction(host.status()).action).toBe("deliver-at-boundary");
    send(event({ epoch: 3, n: 1, turnId: "t-3", event: { kind: "message", text: "per-turn" } }));

    // --- The whole conversation is ONE ordered, exactly-once event stream
    // spanning all three modes and three epochs.
    const t = host.transcript();
    expect(t.events.map((e) => (e.event as { text: string }).text)).toEqual([
      "human turn",
      "session turn",
      "per-turn",
    ]);
    expect(t.events.map((e) => e.epoch)).toEqual([1, 2, 3]);
    const seqs = t.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1);
    expect(new Set(seqs).size).toBe(seqs.length);

    // Exactly-once across BOTH handoffs: each successor replays only what
    // it had not applied - no event is rendered twice, none skipped.
    expect(
      t.events.filter((e) => e.seq > acked1).map((e) => (e.event as { text: string }).text),
    ).toEqual(["session turn", "per-turn"]);
    expect(
      t.events.filter((e) => e.seq > acked2).map((e) => (e.event as { text: string }).text),
    ).toEqual(["per-turn"]);

    // The durable log survives a full restart with the identical transcript
    // (crash-safe end to end).
    const reopened = openConversation(join(root, "conv-1"), {
      now: () => box.now,
      presence: () => false,
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    expect(reopened.transcript()).toEqual(t);
    expect(reopened.state().epoch).toBe(3);
  });
});
