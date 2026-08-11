import { describe, expect, test } from "bun:test";
import { FRAME_KINDS, type Frame } from "../../src/protocol/frames.js";
import {
  type ChannelState,
  initialChannelState,
  isLive,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
  type ReduceResult,
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

const expectAccepted = (result: ReduceResult): Extract<ReduceResult, { verdict: "accepted" }> => {
  if (result.verdict !== "accepted")
    throw new Error(`expected accepted, got refusal: ${result.issue}`);
  return result;
};

const expectRefused = (result: ReduceResult): Extract<ReduceResult, { verdict: "refused" }> => {
  if (result.verdict !== "refused") throw new Error("expected refusal, got accepted");
  return result;
};

/** Drive a sequence of accepted frames and return the final state. */
const drive = (state: ChannelState, frames: readonly (readonly [Frame, number])[]): ChannelState =>
  frames.reduce((current, [frame, at]) => expectAccepted(reduce(current, frame, at)).state, state);

describe("reducer core (M4.2)", () => {
  test("attach with the right secret grants epoch 1, an attach-ok with lease + replayFrom, and a structured record", () => {
    const result = expectAccepted(reduce(fresh(), attach(), 1_000));

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
      conversationId: "conv-1",
      epoch: 1,
      seq: 1,
      profile: "interactive",
      now: 1_000,
    });
  });

  test("attach with a wrong secret is refused auth-failed: state untouched by identity, refused send, record names the issue", () => {
    const state = fresh();
    const result = expectRefused(reduce(state, attach({ secret: "wrong" }), 1_000));

    expect(result.issue).toBe("auth-failed");
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "refused", issue: "auth-failed" } },
    ]);
    expect(result.record).toEqual({
      verdict: "refused",
      kind: "attach",
      conversationId: "conv-1",
      epoch: 0,
      issue: "auth-failed",
      profile: "interactive",
      now: 1_000,
    });
  });

  test("an accepted event mints the next lucid seq, acks the source n, and tracks the in-flight turn", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = expectAccepted(reduce(state, event(), 2_000));

    expect(result.state.seq).toBe(2);
    expect(result.state.attachment?.lastN).toBe(1);
    expect(result.state.turn).toEqual({ turnId: "t-1" });
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "event-ack", epoch: 1, n: 1 } },
    ]);
    expect(result.record).toEqual({
      verdict: "accepted",
      kind: "event",
      conversationId: "conv-1",
      epoch: 1,
      seq: 2,
      n: 1,
      turnId: "t-1",
      now: 2_000,
    });
  });

  test("a duplicate per-epoch n is refused dupe-n and applies nothing", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const result = expectRefused(reduce(state, event({ n: 1, turnId: "t-2" }), 3_000));

    expect(result.issue).toBe("dupe-n");
    expect(result.state).toBe(state);
    expect(result.state.turn).toEqual({ turnId: "t-1" });
    expect(result.record).toEqual({
      verdict: "refused",
      kind: "event",
      conversationId: "conv-1",
      epoch: 1,
      issue: "dupe-n",
      n: 1,
      turnId: "t-2",
      now: 3_000,
    });
  });

  test("a gap in per-epoch n is refused gap-n so the source must resend in order", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const result = expectRefused(reduce(state, event({ n: 3 }), 3_000));

    expect(result.issue).toBe("gap-n");
    expect(result.state).toBe(state);
    expect(result.record.n).toBe(3);
  });

  test("a post-fence refusal still proves the writer alive: gap-n retries renew the lease once renewal is due", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);
    // Renewal is due (>= renewEvery since the last grant), so the refusal
    // renews the lease - the frame itself is still never applied.
    const result = expectRefused(reduce(state, event({ n: 3 }), 10_000));

    expect(result.issue).toBe("gap-n");
    expect(result.state.attachment?.lease.expires).toBe(10_000 + LEASE_TTL_MS);
    expect(result.state.seq).toBe(state.seq);
    expect(result.state.attachment?.lastN).toBe(1);
    expect(result.state.turn).toBe(state.turn);
  });

  test("heartbeat renews the lease from the injected clock and returns an explicit lease grant", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = expectAccepted(reduce(state, { kind: "heartbeat", epoch: 1 }, 6_000));

    expect(result.state.attachment?.lease.expires).toBe(6_000 + LEASE_TTL_MS);
    expect(result.state.seq).toBe(2);
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "lease", epoch: 1, expires: 6_000 + LEASE_TTL_MS } },
    ]);
  });

  test("any accepted frame renews the lease once renewal is due, not just heartbeat", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = expectAccepted(reduce(state, event({ n: 1 }), 9_000));

    expect(result.state.attachment?.lease.expires).toBe(9_000 + LEASE_TTL_MS);
  });

  test("renewal is gated at renewEvery granularity: frames inside the window reuse lease and turn identity", () => {
    const attached = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    const first = expectAccepted(reduce(attached, event({ n: 1 }), 2_000)).state;

    // Inside the renewal window: the lease object (and its expires) is
    // REUSED, so host-side change detection does not fire per token.
    expect(first.attachment?.lease).toBe(attached.attachment?.lease as never);
    expect(first.attachment?.lease.expires).toBe(1_000 + LEASE_TTL_MS);

    // Same turn: the turn object is reused too.
    const second = expectAccepted(reduce(first, event({ n: 2 }), 2_500)).state;
    expect(second.turn).toBe(first.turn as never);
    expect(second.attachment?.lease).toBe(first.attachment?.lease as never);

    // A heartbeat inside the window changes nothing about the attachment:
    // full identity reuse, and the lease grant reports the true expires.
    const beat = expectAccepted(reduce(second, { kind: "heartbeat", epoch: 1 }, 3_000));
    expect(beat.state.attachment).toBe(second.attachment as never);
    expect(beat.effects).toEqual([
      { type: "send", frame: { kind: "lease", epoch: 1, expires: 1_000 + LEASE_TTL_MS } },
    ]);
  });

  test("attach while a valid lease is held is refused lease-held - takeover needs expiry", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = expectRefused(reduce(state, attach({ profile: "headless-session" }), 2_000));

    expect(result.issue).toBe("lease-held");
    expect(result.state).toBe(state);
    expect(result.state.epoch).toBe(1);
  });

  test("isLive is the one exported expiry comparison: live while the lease holds, dead at expiry or detach", () => {
    expect(isLive(fresh(), 0)).toBe(false);

    const attached = drive(fresh(), [[attach(), 1_000]]);
    expect(isLive(attached, 1_000 + LEASE_TTL_MS - 1)).toBe(true);
    expect(isLive(attached, 1_000 + LEASE_TTL_MS)).toBe(false);

    const detached = drive(attached, [[{ kind: "detach", epoch: 1, reason: "yield" }, 2_000]]);
    expect(isLive(detached, 2_001)).toBe(false);
  });

  test("stale-lease takeover: attach after expiry increments the epoch, and the old epoch's frames are refused stale-epoch from that moment", () => {
    const held = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);
    const expiresAt = 1_000 + LEASE_TTL_MS;

    const takeover = expectAccepted(
      reduce(held, attach({ profile: "headless-session" }), expiresAt),
    );
    expect(takeover.state.epoch).toBe(2);
    expect(takeover.state.attachment?.lastN).toBe(0);

    const stale = expectRefused(reduce(takeover.state, event({ epoch: 1, n: 2 }), expiresAt + 1));
    expect(stale.issue).toBe("stale-epoch");
    expect(stale.state).toBe(takeover.state);
    expect(stale.record).toEqual({
      verdict: "refused",
      kind: "event",
      conversationId: "conv-1",
      epoch: 2,
      frameEpoch: 1,
      issue: "stale-epoch",
      n: 2,
      turnId: "t-1",
      now: expiresAt + 1,
    });
  });

  test("two-simultaneous-attach oracle: exactly one writer, loser refused by epoch - not luck", () => {
    // A and B race; the reducer serializes. A lands first and wins epoch 1.
    const aAttached = expectAccepted(reduce(fresh(), attach(), 1_000));

    // B lands second with the SAME correct secret: refused deterministically.
    const bAttach = expectRefused(
      reduce(aAttached.state, attach({ profile: "headless-session" }), 1_001),
    );
    expect(bAttach.issue).toBe("lease-held");

    // B never received attach-ok, so any epoch it presents is not current.
    const bEvent = expectRefused(
      reduce(bAttach.state, event({ epoch: 0, n: 1, turnId: "t-b" }), 1_002),
    );
    expect(bEvent.issue).toBe("stale-epoch");

    // A works: still the one writer.
    const aEvent = expectAccepted(reduce(bEvent.state, event({ epoch: 1, n: 1 }), 1_003));

    // A goes silent; its lease runs out; B retries attach and wins epoch 2.
    const expiresAt = 1_000 + LEASE_TTL_MS;
    const bTakeover = expectAccepted(
      reduce(aEvent.state, attach({ profile: "headless-session" }), expiresAt),
    );
    expect(bTakeover.state.epoch).toBe(2);

    // A wakes up: every frame kind it can send on epoch 1 is now fenced.
    const aStaleEvent = expectRefused(
      reduce(bTakeover.state, event({ epoch: 1, n: 2 }), expiresAt + 1),
    );
    expect(aStaleEvent.issue).toBe("stale-epoch");

    const aStaleHeartbeat = expectRefused(
      reduce(aStaleEvent.state, { kind: "heartbeat", epoch: 1 }, expiresAt + 2),
    );
    expect(aStaleHeartbeat.issue).toBe("stale-epoch");
    // ...and the stale heartbeat must NOT have renewed B's lease.
    expect(aStaleHeartbeat.state.attachment?.lease.expires).toBe(expiresAt + LEASE_TTL_MS);

    // B is the one writer now.
    expectAccepted(
      reduce(aStaleHeartbeat.state, event({ epoch: 2, n: 1, turnId: "t-b" }), expiresAt + 3),
    );
  });

  test("lease expiry mid-turn: the takeover attach aborts the in-flight turn", () => {
    const midTurn = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1, turnId: "t-1" }), 2_000],
    ]);
    expect(midTurn.turn).toEqual({ turnId: "t-1" });

    const takeover = expectAccepted(
      reduce(midTurn, attach({ profile: "headless-session" }), 1_000 + LEASE_TTL_MS),
    );

    expect(takeover.state.turn).toBeNull();
    expect(takeover.effects[0]).toEqual({ type: "abort-turn", turnId: "t-1" });
    expect(takeover.effects[1]?.type).toBe("send");
  });

  test("ack records the source's durable position on the current epoch and is fenced on a stale one", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    const acked = expectAccepted(reduce(state, { kind: "ack", epoch: 1, covers: 2 }, 3_000));
    expect(acked.state.acked).toBe(2);
    expect(acked.state.seq).toBe(3);

    const stale = expectRefused(reduce(acked.state, { kind: "ack", epoch: 0, covers: 2 }, 3_001));
    expect(stale.issue).toBe("stale-epoch");
    expect(stale.state).toBe(acked.state);
  });

  test("acked is monotonic: a re-delivered older ack never rewinds the durable watermark", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
      [event({ n: 2 }), 2_001],
      [event({ n: 3 }), 2_002],
      [{ kind: "ack", epoch: 1, covers: 4 }, 3_000],
    ]);
    expect(state.acked).toBe(4);

    const replayed = expectAccepted(reduce(state, { kind: "ack", epoch: 1, covers: 2 }, 3_001));
    expect(replayed.state.acked).toBe(4);
  });

  test("takeover rebases acked from the NEW writer's resumeFrom - the old writer's watermark never speaks for the new one", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
      [event({ n: 2 }), 2_001],
      [event({ n: 3 }), 2_002],
      [{ kind: "ack", epoch: 1, covers: 4 }, 3_000],
    ]);
    expect(state.acked).toBe(4);

    // A's lease lapses; B attaches having durably applied only through 2.
    const takeover = expectAccepted(
      reduce(state, attach({ profile: "headless-session", resumeFrom: 2 }), 1_000 + LEASE_TTL_MS),
    );
    expect(takeover.state.acked).toBe(2);

    // A plain re-attach with no resumeFrom claims nothing applied.
    const detached = drive(fresh(), [
      [attach(), 1_000],
      [{ kind: "ack", epoch: 1, covers: 1 }, 2_000],
      [{ kind: "detach", epoch: 1, reason: "yield" }, 3_000],
    ]);
    const reattached = expectAccepted(reduce(detached, attach(), 4_000));
    expect(reattached.state.acked).toBe(0);
  });

  test("ack claiming a seq lucid never minted is refused covers-ahead-of-log with the comparison in the record", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = expectRefused(reduce(state, { kind: "ack", epoch: 1, covers: 99 }, 2_000));

    expect(result.issue).toBe("covers-ahead-of-log");
    expect(result.state).toBe(state);
    expect(result.record.detail).toEqual({ claimed: 99, head: 1 });
  });

  test("disposition is accepted with a minted seq on the current epoch and fenced on a stale one", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const applied = expectAccepted(
      reduce(state, { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "applied" }, 2_000),
    );
    expect(applied.state.seq).toBe(2);
    expect(applied.record.seq).toBe(2);

    const stale = expectRefused(
      reduce(
        applied.state,
        { kind: "disposition", epoch: 0, inputId: "in-2", outcome: "applied" },
        2_001,
      ),
    );
    expect(stale.issue).toBe("stale-epoch");
  });

  test("detach releases the channel: later frames are refused not-attached, and re-attach takes the next epoch", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const detached = expectAccepted(
      reduce(state, { kind: "detach", epoch: 1, reason: "yield" }, 2_000),
    );
    expect(detached.state.attachment).toBeNull();
    expect(detached.record.reason).toBe("yield");

    const orphan = expectRefused(reduce(detached.state, event({ epoch: 1, n: 1 }), 2_001));
    expect(orphan.issue).toBe("not-attached");
    expect(orphan.state).toBe(detached.state);

    const reattach = expectAccepted(reduce(detached.state, attach(), 3_000));
    expect(reattach.state.epoch).toBe(2);
  });

  test("detach mid-turn aborts the turn the departing writer can never finish", () => {
    const midTurn = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1, turnId: "t-1" }), 2_000],
    ]);

    const result = expectAccepted(
      reduce(midTurn, { kind: "detach", epoch: 1, reason: "shutdown" }, 3_000),
    );

    expect(result.state.turn).toBeNull();
    expect(result.state.attachment).toBeNull();
    expect(result.effects).toEqual([{ type: "abort-turn", turnId: "t-1" }]);
    expect(result.record.reason).toBe("shutdown");
  });

  test("turnId is validated on first sight: a retired turnId can never come back, same epoch or after takeover", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1, turnId: "t-1" }), 2_000],
      [event({ n: 2, turnId: "t-1" }), 2_001], // same turn continues: fine
      [event({ n: 3, turnId: "t-2" }), 2_002], // turn boundary: t-1 retired
    ]);

    // Same epoch: the retired t-1 cannot be revived.
    const revived = expectRefused(reduce(state, event({ n: 4, turnId: "t-1" }), 2_003));
    expect(revived.issue).toBe("turn-id-reused");
    expect(revived.state.turn).toEqual({ turnId: "t-2" });
    expect(revived.record.turnId).toBe("t-1");

    // Across a takeover: the aborted turn's id is dead too - the new
    // writer must mint a fresh turnId, which enforces the abort.
    const takeover = expectAccepted(
      reduce(state, attach({ profile: "headless-session" }), 1_000 + LEASE_TTL_MS),
    );
    const resumedOld = expectRefused(
      reduce(takeover.state, event({ epoch: 2, n: 1, turnId: "t-2" }), 1_001 + LEASE_TTL_MS),
    );
    expect(resumedOld.issue).toBe("turn-id-reused");

    const freshTurn = expectAccepted(
      reduce(takeover.state, event({ epoch: 2, n: 1, turnId: "t-3" }), 1_001 + LEASE_TTL_MS),
    );
    expect(freshTurn.state.turn).toEqual({ turnId: "t-3" });
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

    // The forged list plus the source->lucid kinds IS the full vocabulary:
    // a kind added to frames.ts without reducer coverage fails here.
    const sourceToLucid = ["attach", "event", "ack", "disposition", "heartbeat", "detach"];
    expect([...new Set([...forged.map((f) => f.kind), ...sourceToLucid])].sort()).toEqual(
      [...FRAME_KINDS].sort(),
    );

    for (const frame of forged) {
      const result = expectRefused(reduce(midTurn, frame, 2_001));
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
      const result = expectRefused(reduce(unattached, frame, 1_000));
      expect(result.issue, `unattached ${frame.kind}`).toBe("not-attached");
      expect(result.state).toBe(unattached);
    }

    const attached = drive(fresh(), [[attach(), 1_000]]);
    for (const [epoch, issue] of [
      [0, "stale-epoch"],
      [2, "future-epoch"],
    ] as const) {
      for (const frame of sourceKinds(epoch)) {
        const result = expectRefused(reduce(attached, frame, 2_000));
        expect(result.issue, `epoch ${epoch} ${frame.kind}`).toBe(issue);
        expect(result.state).toBe(attached);
        expect(result.record.frameEpoch).toBe(epoch);
      }
    }
  });

  test("re-attach negotiates replay: replayFrom is the exclusive watermark (host replays seq > replayFrom), and a claim ahead of the log is refused", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
      [{ kind: "detach", epoch: 1, reason: "yield" }, 3_000],
    ]);
    expect(state.seq).toBe(3);

    const resumed = expectAccepted(reduce(state, attach({ resumeFrom: 2 }), 4_000));
    const sent = resumed.effects.find((e) => e.type === "send");
    if (sent?.frame.kind !== "attach-ok") throw new Error("expected attach-ok");
    // resumeFrom is the last seq the source durably APPLIED, so it is echoed
    // as the exclusive replay watermark: seq 2 is never re-delivered.
    expect(sent.frame.replayFrom).toBe(2);

    const liar = expectRefused(reduce(state, attach({ resumeFrom: 99 }), 4_000));
    expect(liar.issue).toBe("resume-ahead-of-log");
    expect(liar.state).toBe(state);
    expect(liar.record.detail).toEqual({ claimed: 99, head: 3 });
  });

  test("attach addressed to another conversation or an unsupported protocol version is refused before any grant", () => {
    const state = fresh();

    const misrouted = expectRefused(reduce(state, attach({ conversationId: "conv-2" }), 1_000));
    expect(misrouted.issue).toBe("wrong-conversation");
    expect(misrouted.state).toBe(state);

    const futureVersion = expectRefused(
      reduce(state, attach({ version: PROTOCOL_VERSION + 1 }), 1_000),
    );
    expect(futureVersion.issue).toBe("version-unsupported");
    expect(futureVersion.state).toBe(state);
    expect(futureVersion.record.detail).toEqual({
      claimed: PROTOCOL_VERSION + 1,
      head: PROTOCOL_VERSION,
    });
  });
});
