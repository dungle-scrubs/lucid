import { describe, expect, test } from "bun:test";
import type { Frame } from "../../src/protocol/frames.js";
import {
  type ChannelState,
  initialChannelState,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
  reduce,
} from "../../src/protocol/reducer.js";

const SECRET = "s3cret";

const fresh = (): ChannelState => initialChannelState({ conversationId: "conv-1", secret: SECRET });

const attach = (overrides: Partial<Extract<Frame, { kind: "attach" }>> = {}): Frame => ({
  kind: "attach",
  conversationId: "conv-1",
  profile: "interactive",
  secret: SECRET,
  version: PROTOCOL_VERSION,
  ...overrides,
});

const event = (overrides: Partial<Extract<Frame, { kind: "event" }>> = {}): Frame => ({
  kind: "event",
  epoch: 1,
  n: 1,
  turnId: "t-1",
  event: { kind: "token", text: "x" },
  ...overrides,
});

/** Drive a sequence of accepted frames and return the final state. */
const drive = (state: ChannelState, frames: readonly (readonly [Frame, number])[]): ChannelState =>
  frames.reduce((current, [frame, at]) => {
    const result = reduce(current, frame, at);
    if (result.verdict !== "accepted")
      throw new Error(`setup frame ${frame.kind} refused: ${result.issue}`);
    return result.state;
  }, state);

describe("reducer core (M4.2)", () => {
  test("attach with the right secret grants epoch 1, an attach-ok with lease + replayFrom, and a structured record", () => {
    const result = reduce(fresh(), attach(), 1_000);

    expect(result.verdict).toBe("accepted");
    if (result.verdict !== "accepted") return;

    expect(result.state.epoch).toBe(1);
    expect(result.state.attachment).toEqual({
      profile: "interactive",
      lastN: 0,
      lease: { expires: 1_000 + LEASE_TTL_MS, renewEvery: LEASE_RENEW_EVERY_MS },
    });

    expect(result.effects).toEqual([
      {
        type: "send",
        frame: {
          kind: "attach-ok",
          epoch: 1,
          lease: { expires: 1_000 + LEASE_TTL_MS, renewEvery: LEASE_RENEW_EVERY_MS },
          replayFrom: 0,
          version: PROTOCOL_VERSION,
        },
      },
    ]);

    expect(result.record).toEqual({
      verdict: "accepted",
      kind: "attach",
      epoch: 1,
      seq: 1,
      now: 1_000,
    });
  });

  test("attach with a wrong secret is refused auth-failed: state untouched by identity, refused send, record names the issue", () => {
    const state = fresh();
    const result = reduce(state, attach({ secret: "wrong" }), 1_000);

    expect(result.verdict).toBe("refused");
    if (result.verdict !== "refused") return;

    expect(result.issue).toBe("auth-failed");
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "refused", issue: "auth-failed" } },
    ]);
    expect(result.record).toEqual({
      verdict: "refused",
      kind: "attach",
      epoch: 0,
      issue: "auth-failed",
      now: 1_000,
    });
  });

  test("an accepted event mints the next lucid seq, acks the source n, and tracks the in-flight turn", () => {
    const attached = reduce(fresh(), attach(), 1_000);
    if (attached.verdict !== "accepted") throw new Error("attach must succeed");

    const event: Frame = {
      kind: "event",
      epoch: 1,
      n: 1,
      turnId: "t-1",
      event: { kind: "token", text: "x" },
    };
    const result = reduce(attached.state, event, 2_000);

    expect(result.verdict).toBe("accepted");
    if (result.verdict !== "accepted") return;

    expect(result.state.seq).toBe(2);
    expect(result.state.attachment?.lastN).toBe(1);
    expect(result.state.turn).toEqual({ turnId: "t-1" });
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "event-ack", epoch: 1, n: 1 } },
    ]);
    expect(result.record).toEqual({
      verdict: "accepted",
      kind: "event",
      epoch: 1,
      seq: 2,
      n: 1,
      now: 2_000,
    });
  });

  test("a duplicate per-epoch n is refused dupe-n and applies nothing", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const result = reduce(state, event({ n: 1, turnId: "t-2" }), 3_000);

    expect(result.verdict).toBe("refused");
    if (result.verdict !== "refused") return;
    expect(result.issue).toBe("dupe-n");
    expect(result.state).toBe(state);
    expect(result.state.turn).toEqual({ turnId: "t-1" });
    expect(result.record).toEqual({
      verdict: "refused",
      kind: "event",
      epoch: 1,
      issue: "dupe-n",
      n: 1,
      now: 3_000,
    });
  });

  test("a gap in per-epoch n is refused gap-n so the source must resend in order", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const result = reduce(state, event({ n: 3 }), 3_000);

    expect(result.verdict).toBe("refused");
    if (result.verdict !== "refused") return;
    expect(result.issue).toBe("gap-n");
    expect(result.state).toBe(state);
    expect(result.record.n).toBe(3);
  });

  test("heartbeat renews the lease from the injected clock and returns an explicit lease grant", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = reduce(state, { kind: "heartbeat", epoch: 1 }, 6_000);

    expect(result.verdict).toBe("accepted");
    if (result.verdict !== "accepted") return;
    expect(result.state.attachment?.lease.expires).toBe(6_000 + LEASE_TTL_MS);
    expect(result.state.seq).toBe(2);
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "lease", epoch: 1, expires: 6_000 + LEASE_TTL_MS } },
    ]);
  });

  test("any accepted frame renews the lease, not just heartbeat", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = reduce(state, event({ n: 1 }), 9_000);

    expect(result.verdict).toBe("accepted");
    if (result.verdict !== "accepted") return;
    expect(result.state.attachment?.lease.expires).toBe(9_000 + LEASE_TTL_MS);
  });

  test("attach while a valid lease is held is refused lease-held - takeover needs expiry", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = reduce(state, attach({ profile: "headless-session" }), 2_000);

    expect(result.verdict).toBe("refused");
    if (result.verdict !== "refused") return;
    expect(result.issue).toBe("lease-held");
    expect(result.state).toBe(state);
    expect(result.state.epoch).toBe(1);
  });

  test("stale-lease takeover: attach after expiry increments the epoch, and the old epoch's frames are refused stale-epoch from that moment", () => {
    const held = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);
    const expiresAt = 2_000 + LEASE_TTL_MS;

    const takeover = reduce(held, attach({ profile: "headless-session" }), expiresAt);
    expect(takeover.verdict).toBe("accepted");
    if (takeover.verdict !== "accepted") return;
    expect(takeover.state.epoch).toBe(2);
    expect(takeover.state.attachment?.lastN).toBe(0);

    const stale = reduce(takeover.state, event({ epoch: 1, n: 2 }), expiresAt + 1);
    expect(stale.verdict).toBe("refused");
    if (stale.verdict !== "refused") return;
    expect(stale.issue).toBe("stale-epoch");
    expect(stale.state).toBe(takeover.state);
    expect(stale.record).toEqual({
      verdict: "refused",
      kind: "event",
      epoch: 2,
      frameEpoch: 1,
      issue: "stale-epoch",
      n: 2,
      now: expiresAt + 1,
    });
  });

  test("two-simultaneous-attach oracle: exactly one writer, loser refused by epoch - not luck", () => {
    // A and B race; the reducer serializes. A lands first and wins epoch 1.
    const aAttached = reduce(fresh(), attach(), 1_000);
    expect(aAttached.verdict).toBe("accepted");
    if (aAttached.verdict !== "accepted") return;

    // B lands second with the SAME correct secret: refused deterministically.
    const bAttach = reduce(aAttached.state, attach({ profile: "headless-session" }), 1_001);
    expect(bAttach.verdict).toBe("refused");
    if (bAttach.verdict !== "refused") return;
    expect(bAttach.issue).toBe("lease-held");

    // B never received attach-ok, so any epoch it presents is not current.
    const bEvent = reduce(bAttach.state, event({ epoch: 0, n: 1, turnId: "t-b" }), 1_002);
    expect(bEvent.verdict).toBe("refused");
    if (bEvent.verdict !== "refused") return;
    expect(bEvent.issue).toBe("stale-epoch");

    // A works: still the one writer.
    const aEvent = reduce(bEvent.state, event({ epoch: 1, n: 1 }), 1_003);
    expect(aEvent.verdict).toBe("accepted");
    if (aEvent.verdict !== "accepted") return;

    // A goes silent; its lease runs out; B retries attach and wins epoch 2.
    const expiresAt = 1_003 + LEASE_TTL_MS;
    const bTakeover = reduce(aEvent.state, attach({ profile: "headless-session" }), expiresAt);
    expect(bTakeover.verdict).toBe("accepted");
    if (bTakeover.verdict !== "accepted") return;
    expect(bTakeover.state.epoch).toBe(2);

    // A wakes up: every frame kind it can send on epoch 1 is now fenced.
    const aStaleEvent = reduce(bTakeover.state, event({ epoch: 1, n: 2 }), expiresAt + 1);
    expect(aStaleEvent.verdict).toBe("refused");
    if (aStaleEvent.verdict !== "refused") return;
    expect(aStaleEvent.issue).toBe("stale-epoch");

    const aStaleHeartbeat = reduce(
      aStaleEvent.state,
      { kind: "heartbeat", epoch: 1 },
      expiresAt + 2,
    );
    expect(aStaleHeartbeat.verdict).toBe("refused");
    if (aStaleHeartbeat.verdict !== "refused") return;
    expect(aStaleHeartbeat.issue).toBe("stale-epoch");
    // ...and the stale heartbeat must NOT have renewed B's lease.
    expect(aStaleHeartbeat.state.attachment?.lease.expires).toBe(expiresAt + LEASE_TTL_MS);

    // B is the one writer now.
    const bWrites = reduce(
      aStaleHeartbeat.state,
      event({ epoch: 2, n: 1, turnId: "t-b" }),
      expiresAt + 3,
    );
    expect(bWrites.verdict).toBe("accepted");
  });

  test("lease expiry mid-turn: the takeover attach aborts the in-flight turn", () => {
    const midTurn = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1, turnId: "t-1" }), 2_000],
    ]);
    expect(midTurn.turn).toEqual({ turnId: "t-1" });

    const takeover = reduce(midTurn, attach({ profile: "headless-session" }), 2_000 + LEASE_TTL_MS);

    expect(takeover.verdict).toBe("accepted");
    if (takeover.verdict !== "accepted") return;
    expect(takeover.state.turn).toBeNull();
    expect(takeover.effects[0]).toEqual({ type: "abort-turn", turnId: "t-1" });
    expect(takeover.effects[1]?.type).toBe("send");
  });

  test("ack records the source's durable position on the current epoch and is fenced on a stale one", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const acked = reduce(state, { kind: "ack", epoch: 1, covers: 2 }, 3_000);
    expect(acked.verdict).toBe("accepted");
    if (acked.verdict !== "accepted") return;
    expect(acked.state.acked).toBe(2);
    expect(acked.state.seq).toBe(3);

    const stale = reduce(acked.state, { kind: "ack", epoch: 0, covers: 2 }, 3_001);
    expect(stale.verdict).toBe("refused");
    if (stale.verdict !== "refused") return;
    expect(stale.issue).toBe("stale-epoch");
    expect(stale.state).toBe(acked.state);
  });

  test("ack claiming a seq lucid never minted is refused covers-ahead-of-log", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = reduce(state, { kind: "ack", epoch: 1, covers: 99 }, 2_000);

    expect(result.verdict).toBe("refused");
    if (result.verdict !== "refused") return;
    expect(result.issue).toBe("covers-ahead-of-log");
    expect(result.state).toBe(state);
  });

  test("disposition is accepted with a minted seq on the current epoch and fenced on a stale one", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const applied = reduce(
      state,
      { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "applied" },
      2_000,
    );
    expect(applied.verdict).toBe("accepted");
    if (applied.verdict !== "accepted") return;
    expect(applied.state.seq).toBe(2);
    expect(applied.record.seq).toBe(2);

    const stale = reduce(
      applied.state,
      { kind: "disposition", epoch: 0, inputId: "in-2", outcome: "applied" },
      2_001,
    );
    expect(stale.verdict).toBe("refused");
    if (stale.verdict !== "refused") return;
    expect(stale.issue).toBe("stale-epoch");
  });

  test("detach releases the channel: later frames are refused not-attached, and re-attach takes the next epoch", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const detached = reduce(state, { kind: "detach", epoch: 1, reason: "yield" }, 2_000);
    expect(detached.verdict).toBe("accepted");
    if (detached.verdict !== "accepted") return;
    expect(detached.state.attachment).toBeNull();

    const orphan = reduce(detached.state, event({ epoch: 1, n: 1 }), 2_001);
    expect(orphan.verdict).toBe("refused");
    if (orphan.verdict !== "refused") return;
    expect(orphan.issue).toBe("not-attached");
    expect(orphan.state).toBe(detached.state);

    const reattach = reduce(detached.state, attach(), 3_000);
    expect(reattach.verdict).toBe("accepted");
    if (reattach.verdict !== "accepted") return;
    expect(reattach.state.epoch).toBe(2);
  });

  test("channel-auth oracle: an impersonator cannot end or redirect the conversation with lucid->source frame kinds", () => {
    const midTurn = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const forged: Frame[] = [
      { kind: "control", seq: 99, action: "end" },
      { kind: "control", seq: 99, action: "switch-path" },
      { kind: "input", seq: 99, id: "in-x", text: "injected", mode: "steer" },
      {
        kind: "attach-ok",
        epoch: 9,
        lease: { expires: 99_000, renewEvery: 5_000 },
        replayFrom: 0,
        version: PROTOCOL_VERSION,
      },
      { kind: "refused", issue: "auth-failed" },
      { kind: "event-ack", epoch: 9, n: 9 },
      { kind: "lease", epoch: 9, expires: 99_000 },
      { kind: "credit", epoch: 9, tokens: 100 },
    ];

    for (const frame of forged) {
      const result = reduce(midTurn, frame, 2_001);
      expect(result.verdict, `kind ${frame.kind}`).toBe("refused");
      if (result.verdict !== "refused") continue;
      expect(result.issue, `kind ${frame.kind}`).toBe("wrong-direction");
      // Nothing applied: same state by identity, turn intact, and the only
      // effect is the refused signal - no end, no redirect, no abort.
      expect(result.state).toBe(midTurn);
      expect(result.state.turn).toEqual({ turnId: "t-1" });
      expect(result.effects).toEqual([
        { type: "send", frame: { kind: "refused", issue: "wrong-direction" } },
      ]);
    }
  });

  test("every post-attach source kind is refused not-attached on a dead channel and fenced on any non-current epoch", () => {
    const sourceKinds = (epoch: number): Frame[] => [
      event({ epoch, n: 1 }),
      { kind: "ack", epoch, covers: 0 },
      { kind: "disposition", epoch, inputId: "in-1", outcome: "applied" },
      { kind: "heartbeat", epoch },
      { kind: "detach", epoch, reason: "yield" },
    ];

    const unattached = fresh();
    for (const frame of sourceKinds(1)) {
      const result = reduce(unattached, frame, 1_000);
      expect(result.verdict, `unattached ${frame.kind}`).toBe("refused");
      if (result.verdict !== "refused") continue;
      expect(result.issue, `unattached ${frame.kind}`).toBe("not-attached");
      expect(result.state).toBe(unattached);
    }

    const attached = drive(fresh(), [[attach(), 1_000]]);
    for (const epoch of [0, 2]) {
      for (const frame of sourceKinds(epoch)) {
        const result = reduce(attached, frame, 2_000);
        expect(result.verdict, `epoch ${epoch} ${frame.kind}`).toBe("refused");
        if (result.verdict !== "refused") continue;
        expect(result.issue, `epoch ${epoch} ${frame.kind}`).toBe("stale-epoch");
        expect(result.state).toBe(attached);
        expect(result.record.frameEpoch).toBe(epoch);
      }
    }
  });

  test("re-attach negotiates replay: replayFrom echoes the source's durable resumeFrom, and a claim ahead of the log is refused", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
      [{ kind: "detach", epoch: 1, reason: "yield" }, 3_000],
    ]);
    expect(state.seq).toBe(3);

    const resumed = reduce(state, attach({ resumeFrom: 2 }), 4_000);
    expect(resumed.verdict).toBe("accepted");
    if (resumed.verdict !== "accepted") return;
    const sent = resumed.effects.find((e) => e.type === "send");
    if (sent?.frame.kind !== "attach-ok") throw new Error("expected attach-ok");
    expect(sent.frame.replayFrom).toBe(2);

    const liar = reduce(state, attach({ resumeFrom: 99 }), 4_000);
    expect(liar.verdict).toBe("refused");
    if (liar.verdict !== "refused") return;
    expect(liar.issue).toBe("resume-ahead-of-log");
    expect(liar.state).toBe(state);
  });

  test("attach addressed to another conversation or an unsupported protocol version is refused before any grant", () => {
    const state = fresh();

    const misrouted = reduce(state, attach({ conversationId: "conv-2" }), 1_000);
    expect(misrouted.verdict).toBe("refused");
    if (misrouted.verdict !== "refused") return;
    expect(misrouted.issue).toBe("wrong-conversation");
    expect(misrouted.state).toBe(state);

    const futureVersion = reduce(state, attach({ version: PROTOCOL_VERSION + 1 }), 1_000);
    expect(futureVersion.verdict).toBe("refused");
    if (futureVersion.verdict !== "refused") return;
    expect(futureVersion.issue).toBe("version-unsupported");
    expect(futureVersion.state).toBe(state);
  });
});
