import { describe, expect, test } from "bun:test";
import { DROPPABLE_QUEUE_MAX, INPUT_QUEUE_MAX } from "../../src/protocol/events.js";
import {
  FRAME_KINDS,
  type Frame,
  INPUT_MODES,
  type InputMode,
  parseFrame,
} from "../../src/protocol/frames.js";
import { InputLedger } from "../../src/protocol/ledgers/input.js";
import {
  type ChannelState,
  enqueueInput,
  grantCredit,
  initialChannelState,
  isLive,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
  reduce,
} from "../../src/protocol/reducer.js";
import { attach, drive, event, expectAccepted, expectRefused, fresh } from "./helpers.js";

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
      presence: "unknown",
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
    const state = expectAccepted(
      enqueueInput(
        drive(fresh(), [[attach(), 1_000]]),
        { id: "in-1", text: "a", mode: "queue" },
        1_500,
      ),
    ).state;

    const applied = expectAccepted(
      reduce(state, { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "applied" }, 2_000),
    );
    expect(applied.state.seq).toBe(3);
    expect(applied.record.seq).toBe(3);

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

  test("enqueueInput mints a seq, stores the input as outstanding, and sends it to the attached source", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const result = expectAccepted(
      enqueueInput(state, { id: "in-1", text: "hello", mode: "queue" }, 2_000),
    );

    expect(result.state.seq).toBe(2);
    expect(result.state.inputs).toEqual([
      {
        id: "in-1",
        seq: 2,
        text: "hello",
        mode: "queue",
        status: "outstanding",
        rejections: 0,
        redeliver: false,
      },
    ]);
    expect(result.effects).toEqual([
      { type: "send", frame: { kind: "input", seq: 2, id: "in-1", text: "hello", mode: "queue" } },
    ]);
    expect(result.record).toEqual({
      verdict: "accepted",
      kind: "input",
      conversationId: "conv-1",
      epoch: 1,
      seq: 2,
      inputId: "in-1",
      queueDepth: 1,
      inFlightInputs: 0,
      now: 2_000,
    });
  });

  test("enqueueInput with a reused id is refused input-id-reused - the idempotency key is never minted twice", () => {
    const state = expectAccepted(
      enqueueInput(
        drive(fresh(), [[attach(), 1_000]]),
        { id: "in-1", text: "a", mode: "queue" },
        2_000,
      ),
    ).state;

    const result = expectRefused(
      enqueueInput(state, { id: "in-1", text: "b", mode: "queue" }, 2_001),
    );

    expect(result.issue).toBe("input-id-reused");
    expect(result.state).toBe(state);
    // A host-side programming error is never reported TO the source.
    expect(result.effects).toEqual([]);
  });

  test("disposition drives the input state machine: outstanding -> queued -> applied, and an unknown inputId is refused", () => {
    const state = expectAccepted(
      enqueueInput(
        drive(fresh(), [[attach(), 1_000]]),
        { id: "in-1", text: "a", mode: "queue" },
        2_000,
      ),
    ).state;

    const queued = expectAccepted(
      reduce(state, { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "queued" }, 3_000),
    );
    expect(queued.state.inputs[0]?.status).toBe("queued");
    expect(queued.record.inputId).toBe("in-1");
    expect(queued.record.outcome).toBe("queued");
    expect(queued.record.inputStatus).toBe("queued");
    // The gauge counts inputs AWAITING disposition - queued is accepted.
    expect(queued.record.queueDepth).toBe(0);

    const applied = expectAccepted(
      reduce(
        queued.state,
        { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "applied" },
        4_000,
      ),
    );
    // Applied entries leave the queue; only the id survives for dedupe.
    expect(applied.state.inputs).toEqual([]);
    expect(applied.record.inputStatus).toBe("applied");
    expect(applied.record.queueDepth).toBe(0);

    const unknown = expectRefused(
      reduce(
        applied.state,
        { kind: "disposition", epoch: 1, inputId: "in-9", outcome: "applied" },
        5_000,
      ),
    );
    expect(unknown.issue).toBe("unknown-input");
    expect(unknown.record.inputId).toBe("in-9");
  });

  test("a rejected input returns to the queue - never dropped - and is re-sent at the next turn boundary", () => {
    const withInput = expectAccepted(
      enqueueInput(
        drive(fresh(), [
          [attach(), 1_000],
          [event({ n: 1, turnId: "t-1" }), 1_500],
        ]),
        { id: "in-1", text: "hello", mode: "queue" },
        2_000,
      ),
    ).state;

    const rejected = expectAccepted(
      reduce(
        withInput,
        { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "rejected", note: "mid-turn" },
        3_000,
      ),
    );
    expect(rejected.state.inputs[0]).toMatchObject({ status: "outstanding", rejections: 1 });
    expect(rejected.record.queueDepth).toBe(1);

    // Mid-turn events do NOT redeliver; the boundary (a new turnId) does.
    const midTurn = expectAccepted(reduce(rejected.state, event({ n: 2, turnId: "t-1" }), 3_500));
    expect(midTurn.effects).toEqual([
      { type: "send", frame: { kind: "event-ack", epoch: 1, n: 2 } },
    ]);

    const boundary = expectAccepted(reduce(midTurn.state, event({ n: 3, turnId: "t-2" }), 4_000));
    expect(boundary.effects).toEqual([
      { type: "send", frame: { kind: "event-ack", epoch: 1, n: 3 } },
      {
        type: "send",
        frame: { kind: "input", seq: withInput.seq, id: "in-1", text: "hello", mode: "queue" },
      },
    ]);

    // One redelivery per rejection: the NEXT boundary does not resend...
    const later = expectAccepted(reduce(boundary.state, event({ n: 4, turnId: "t-3" }), 5_000));
    expect(later.effects).toEqual([{ type: "send", frame: { kind: "event-ack", epoch: 1, n: 4 } }]);

    // ...until a fresh rejection re-arms it.
    const again = drive(later.state, [
      [{ kind: "disposition", epoch: 1, inputId: "in-1", outcome: "rejected" }, 5_500],
    ]);
    const rearmed = expectAccepted(reduce(again, event({ n: 5, turnId: "t-4" }), 6_000));
    expect(rearmed.effects[1]).toEqual({
      type: "send",
      frame: { kind: "input", seq: withInput.seq, id: "in-1", text: "hello", mode: "queue" },
    });
  });

  test("attach replays non-applied inputs with seq > replayFrom, in seq order, after attach-ok", () => {
    // Build: input 2 (applied), input 3 (outstanding), input 4 (outstanding),
    // then the source detaches.
    let state = drive(fresh(), [[attach(), 1_000]]);
    state = expectAccepted(
      enqueueInput(state, { id: "in-a", text: "a", mode: "queue" }, 1_100),
    ).state;
    state = expectAccepted(
      enqueueInput(state, { id: "in-b", text: "b", mode: "queue" }, 1_200),
    ).state;
    state = expectAccepted(
      enqueueInput(state, { id: "in-c", text: "c", mode: "queue" }, 1_300),
    ).state;
    state = drive(state, [
      [{ kind: "disposition", epoch: 1, inputId: "in-a", outcome: "applied" }, 1_400],
      [{ kind: "detach", epoch: 1, reason: "yield" }, 1_500],
    ]);

    // The source durably applied through seq 2 (input in-a).
    const resumed = expectAccepted(reduce(state, attach({ resumeFrom: 2 }), 2_000));

    const sends = resumed.effects.filter((e) => e.type === "send").map((e) => e.frame);
    expect(sends[0]?.kind).toBe("attach-ok");
    expect(sends.slice(1)).toEqual([
      { kind: "input", seq: 3, id: "in-b", text: "b", mode: "queue" },
      { kind: "input", seq: 4, id: "in-c", text: "c", mode: "queue" },
    ]);

    // Replay is gated by lucid's own disposition state, never by the
    // source's claim: a resumeFrom at the log head still replays every
    // non-applied input (ids make redelivery safe; trusting the claim
    // would let one bogus attach silently drop the whole queue).
    const claimant = expectAccepted(reduce(state, attach({ resumeFrom: state.seq }), 2_000));
    const claimed = claimant.effects.filter((e) => e.type === "send").map((e) => e.frame);
    expect(claimed.slice(1)).toEqual([
      { kind: "input", seq: 3, id: "in-b", text: "b", mode: "queue" },
      { kind: "input", seq: 4, id: "in-c", text: "c", mode: "queue" },
    ]);
  });

  test("death-before-ack oracle: applied at the source, died before disposition - replay redelivers the same id, dedupe keeps it exactly-once", () => {
    // Input delivered; the source applies it but dies before its
    // disposition reaches lucid.
    const sent = expectAccepted(
      enqueueInput(
        drive(fresh(), [[attach(), 1_000]]),
        { id: "in-1", text: "go", mode: "queue" },
        2_000,
      ),
    );
    expect(sent.effects).toEqual([
      { type: "send", frame: { kind: "input", seq: 2, id: "in-1", text: "go", mode: "queue" } },
    ]);

    // Reconnect after lease expiry. The source's durable log has the input
    // applied, but its resumeFrom claim predates it (it crashed before
    // fsyncing the watermark) - worst case, it claims nothing.
    const reattached = expectAccepted(
      reduce(sent.state, attach({ resumeFrom: 0 }), 1_000 + LEASE_TTL_MS),
    );
    const replayedInputs = reattached.effects
      .filter((e) => e.type === "send")
      .map((e) => e.frame)
      .filter((f) => f.kind === "input");
    // The SAME id and seq travel again - that identity is what lets the
    // source dedupe instead of applying twice.
    expect(replayedInputs).toEqual([
      { kind: "input", seq: 2, id: "in-1", text: "go", mode: "queue" },
    ]);

    // The source dedupes, reports applied under the new epoch: exactly one
    // durable application in lucid's accounting.
    const applied = expectAccepted(
      reduce(
        reattached.state,
        { kind: "disposition", epoch: 2, inputId: "in-1", outcome: "applied" },
        1_001 + LEASE_TTL_MS,
      ),
    );
    expect(applied.state.inputs).toEqual([]);
    expect(applied.record.queueDepth).toBe(0);

    // A redelivered duplicate disposition is an idempotent no-op.
    const dupe = expectAccepted(
      reduce(
        applied.state,
        { kind: "disposition", epoch: 2, inputId: "in-1", outcome: "applied" },
        1_002 + LEASE_TTL_MS,
      ),
    );
    expect(dupe.state.inputs).toEqual(applied.state.inputs);
  });

  test("grantCredit mints a credit frame for the droppable class, clamped so outstanding credits never exceed DROPPABLE_QUEUE_MAX", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    const granted = expectAccepted(grantCredit(state, 10, 2_000));
    expect(granted.state.credits).toBe(10);
    expect(granted.effects).toEqual([
      { type: "send", frame: { kind: "credit", epoch: 1, tokens: 10 } },
    ]);
    expect(granted.record).toEqual({
      verdict: "accepted",
      kind: "credit",
      conversationId: "conv-1",
      epoch: 1,
      tokens: 10,
      credits: 10,
      now: 2_000,
    });

    // A grant beyond the bound is clamped to the remaining headroom...
    const clamped = expectAccepted(grantCredit(granted.state, DROPPABLE_QUEUE_MAX, 2_001));
    expect(clamped.state.credits).toBe(DROPPABLE_QUEUE_MAX);
    expect(clamped.effects).toEqual([
      { type: "send", frame: { kind: "credit", epoch: 1, tokens: DROPPABLE_QUEUE_MAX - 10 } },
    ]);

    // ...and at the cap the grant is a no-op: no zero-token frame is sent.
    const atCap = expectAccepted(grantCredit(clamped.state, 5, 2_002));
    expect(atCap.state).toBe(clamped.state);
    expect(atCap.effects).toEqual([]);

    // No channel, no credit - and no refused frame sent to nobody.
    const dead = expectRefused(grantCredit(fresh(), 5, 2_003));
    expect(dead.issue).toBe("not-attached");
    expect(dead.effects).toEqual([]);

    // A grant that is not a positive safe integer is a host bug: refused
    // without touching the balance and without a wire frame.
    for (const bad of [-5, 0.5, Number.NaN, 2 ** 53]) {
      const invalid = expectRefused(grantCredit(clamped.state, bad, 2_004));
      expect(invalid.issue, `tokens=${bad}`).toBe("invalid-grant");
      expect(invalid.state).toBe(clamped.state);
      expect(invalid.effects).toEqual([]);
    }

    // Credit is per-writer flow control: a takeover resets the balance
    // exactly like acked (the new writer never received those grants).
    const detached = drive(clamped.state, [[{ kind: "detach", epoch: 1, reason: "yield" }, 3_000]]);
    const successor = expectAccepted(reduce(detached, attach(), 4_000));
    expect(successor.state.credits).toBe(0);
  });

  test("droppable events consume a credit and are refused no-credit under starvation; the lossless class is never gated", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    // Starvation from the start: no credit granted yet.
    const starved = expectRefused(
      reduce(state, event({ n: 1, event: { kind: "token", text: "x" } }), 2_000),
    );
    expect(starved.issue).toBe("no-credit");
    expect(starved.record.credits).toBe(0);
    // lastN untouched: the source resends the same n once credit arrives.
    expect(starved.state.attachment?.lastN).toBe(0);

    // Lossless flows regardless of credit.
    const lossless = expectAccepted(
      reduce(state, event({ n: 1, event: { kind: "message", text: "done" } }), 2_001),
    );
    expect(lossless.state.credits).toBe(0);

    // With credit granted, droppable flows and the balance decrements.
    const funded = expectAccepted(grantCredit(lossless.state, 2, 2_002)).state;
    const first = expectAccepted(
      reduce(funded, event({ n: 2, event: { kind: "token", text: "y" } }), 2_003),
    );
    expect(first.state.credits).toBe(1);
    expect(first.record.credits).toBe(1);

    const second = expectAccepted(
      reduce(first.state, event({ n: 3, event: { kind: "progress", note: "…" } }), 2_004),
    );
    expect(second.state.credits).toBe(0);

    // Balance exhausted: the next droppable is refused, lossless still flows.
    const exhausted = expectRefused(
      reduce(second.state, event({ n: 4, event: { kind: "context", pct: 50 } }), 2_005),
    );
    expect(exhausted.issue).toBe("no-credit");
    expectAccepted(reduce(second.state, event({ n: 4, event: { kind: "done" } }), 2_006));
  });

  test("heartbeat-vs-slow-turn oracle: a long silent turn with current heartbeats is NOT takeover-eligible; stopped heartbeats are", () => {
    // Turn starts, then 60s of silence - but heartbeats stay current.
    let state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1, turnId: "t-1" }), 2_000],
    ]);
    for (let at = 7_000; at <= 62_000; at += LEASE_RENEW_EVERY_MS) {
      state = drive(state, [[{ kind: "heartbeat", epoch: 1 }, at]]);
    }

    // Slow turn, live channel: a contender is refused - not unattached.
    const contender = expectRefused(reduce(state, attach({ profile: "headless-session" }), 63_000));
    expect(contender.issue).toBe("lease-held");
    expect(isLive(state, 63_000)).toBe(true);

    // Heartbeats stop; the lease runs out; NOW takeover is legal and the
    // in-flight turn is aborted.
    const expiresAt = 62_000 + LEASE_TTL_MS;
    expect(isLive(state, expiresAt)).toBe(false);
    const takeover = expectAccepted(
      reduce(state, attach({ profile: "headless-session" }), expiresAt),
    );
    expect(takeover.effects[0]).toEqual({ type: "abort-turn", turnId: "t-1" });
  });

  test("malformed frames mid-stream never reach the reducer and never disturb continuity", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1 }), 2_000],
    ]);

    // A torn line, a non-frame, and an unknown kind arrive mid-stream: the
    // codec refuses each with a named issue and no state exists to corrupt.
    for (const [line, issue] of [
      ['{"kind":"event","epoch":1', "not-json"],
      ['"just a string"', "not-a-frame"],
      ['{"kind":"teleport","epoch":1}', "unknown-kind"],
      ['{"kind":"event","epoch":1,"n":2}', "missing-field"],
    ] as const) {
      expect(parseFrame(line)).toEqual({ verdict: "refused", issue });
    }

    // The stream continues exactly where it left off: n=2 is next.
    const next = expectAccepted(reduce(state, event({ n: 2 }), 3_000));
    expect(next.state.attachment?.lastN).toBe(2);
  });

  test("cross-conversation isolation oracle: one conversation's traffic cannot touch another's state", () => {
    const stateA = drive(initialChannelState({ conversationId: "conv-a", secret: "secret-a" }), [
      [attach({ conversationId: "conv-a", secret: "secret-a" }), 1_000],
    ]);
    const freshB = initialChannelState({ conversationId: "conv-b", secret: "secret-b" });

    // A's attach (right secret, wrong conversation) is refused on B before
    // the secret is even considered.
    const misrouted = expectRefused(
      reduce(freshB, attach({ conversationId: "conv-a", secret: "secret-a" }), 2_000),
    );
    expect(misrouted.issue).toBe("wrong-conversation");
    expect(misrouted.state).toBe(freshB);

    // A's secret presented AS conv-b is an auth failure on B.
    const stolen = expectRefused(
      reduce(freshB, attach({ conversationId: "conv-b", secret: "secret-a" }), 2_001),
    );
    expect(stolen.issue).toBe("auth-failed");

    // A's epoch means nothing on B: no attachment there, frames refused.
    const leaked = expectRefused(reduce(freshB, event({ epoch: 1, n: 1 }), 2_002));
    expect(leaked.issue).toBe("not-attached");

    // Input ids are per-conversation: the same id in both is no collision.
    const bAttached = drive(freshB, [
      [attach({ conversationId: "conv-b", secret: "secret-b" }), 3_000],
    ]);
    expectAccepted(enqueueInput(stateA, { id: "in-1", text: "for A", mode: "queue" }, 4_000));
    expectAccepted(enqueueInput(bAttached, { id: "in-1", text: "for B", mode: "queue" }, 4_001));
  });

  test("enqueueInput never sends into an expired lease: the input is queued, armed, and delivered on recovery or replay", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);
    const expiresAt = 1_000 + LEASE_TTL_MS;

    // Lease expired (takeover-eligible window): accept + queue, do NOT send.
    const parked = expectAccepted(
      enqueueInput(state, { id: "in-1", text: "wait", mode: "queue" }, expiresAt),
    );
    expect(parked.effects).toEqual([]);

    // The writer recovers (heartbeat renews the lease): the armed input is
    // delivered at the next turn boundary.
    const recovered = drive(parked.state, [[{ kind: "heartbeat", epoch: 1 }, expiresAt + 1]]);
    const boundary = expectAccepted(
      reduce(recovered, event({ n: 1, turnId: "t-1" }), expiresAt + 2),
    );
    expect(boundary.effects[1]).toEqual({
      type: "send",
      frame: { kind: "input", seq: parked.state.seq, id: "in-1", text: "wait", mode: "queue" },
    });

    // grantCredit refuses on a dead channel instead of resupplying a
    // takeover-eligible writer.
    const dead = expectRefused(grantCredit(parked.state, 5, expiresAt));
    expect(dead.issue).toBe("not-attached");
    expect(dead.effects).toEqual([]);
  });

  test("enqueueInput is exactly as strict as the wire codec: invalid id/turnId/text refused before any state change", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    for (const bad of [
      { id: "", text: "x", mode: "queue" as const },
      { id: "a\nb", text: "x", mode: "queue" as const },
      { id: "in-1", text: "x", mode: "queue" as const, turnId: "t\u0000" },
      { id: "in-1", text: "y".repeat(1_000_001), mode: "queue" as const },
    ]) {
      const result = expectRefused(enqueueInput(state, bad, 2_000));
      expect(result.issue).toBe("invalid-input");
      expect(result.state).toBe(state);
      expect(result.effects).toEqual([]);
    }
  });

  test("an input whose mode is outside INPUT_MODES is refused wrong-type, wherever it came from (RFC-05 B4)", () => {
    const state = drive(fresh(), [[attach(), 1_000]]);

    // A truly unknown mode is the fold path in miniature: a durable input's
    // payload is JSON typed only by claim (validEntry checks the envelope),
    // so the InputMode annotation on the parameter proves nothing at runtime.
    // On the wire the codec refuses this value with wrong-type; the reducer
    // must refuse it with the SAME issue, or a folded entry is silently
    // reinterpreted as an ordinary send. "answer" is now known (T45) and
    // tested separately.
    const refused = expectRefused(
      enqueueInput(state, { id: "ans-1", text: "x", mode: "yolo" as unknown as InputMode }, 2_000),
    );
    expect(refused.issue).toBe("wrong-type");
    expect(refused.state).toBe(state);
    expect(refused.state.inputs).toEqual([]);
    expect(refused.effects).toEqual([]);

    // Garbage is the same refusal, and it wins over the wire-shape checks
    // deliberately: a mode this build cannot even name is the more
    // fundamental fault.
    const garbage = expectRefused(
      enqueueInput(state, { id: "", text: "x", mode: "urgent" as unknown as InputMode }, 2_001),
    );
    expect(garbage.issue).toBe("wrong-type");

    // Every mode this build DOES know still enqueues - the closed set is
    // INPUT_MODES itself, the same array the codec checks against. Answer
    // needs its turnId to be wire-valid; other modes need none.
    for (const mode of INPUT_MODES) {
      if (mode === "answer") {
        const qState = expectAccepted(
          reduce(
            state,
            {
              kind: "event",
              epoch: 1,
              n: 1,
              turnId: "t-1",
              event: { kind: "question", question: "Q?" },
            } as unknown as Frame,
            2_001,
          ),
        ).state;
        const input = { id: `in-${mode}`, text: "x", mode, turnId: "t-1" };
        const ok = expectAccepted(enqueueInput(qState, input, 2_002));
        expect(ok.state.inputs.some((i) => i.id === `in-${mode}`)).toBe(true);
      } else {
        const input = { id: `in-${mode}`, text: "x", mode } as const;
        const ok = expectAccepted(enqueueInput(state, input, 2_002));
        expect(ok.state.inputs.some((i) => i.id === `in-${mode}`)).toBe(true);
      }
    }
  });

  test("steer cannot be requested at a headless-turn attachment - a turn in flight cannot be interjected there", () => {
    const state = drive(fresh(), [[attach({ profile: "headless-turn" }), 1_000]]);

    const result = expectRefused(
      enqueueInput(state, { id: "in-1", text: "x", mode: "steer" }, 2_000),
    );
    expect(result.issue).toBe("steer-unsupported");
    expect(result.state).toBe(state);

    // queue mode is always legal.
    expectAccepted(enqueueInput(state, { id: "in-2", text: "x", mode: "queue" }, 2_001));
  });

  test("starvation delays boundary redelivery but never loses it: once credit resumes, the resent boundary event delivers", () => {
    // Turn t-1 runs; an input is rejected (armed for boundary delivery);
    // credit is exhausted.
    const armed = drive(
      expectAccepted(
        enqueueInput(
          drive(fresh(), [
            [attach(), 1_000],
            [event({ n: 1, turnId: "t-1" }), 1_500],
          ]),
          { id: "in-1", text: "go", mode: "queue" },
          2_000,
        ),
      ).state,
      [[{ kind: "disposition", epoch: 1, inputId: "in-1", outcome: "rejected" }, 2_500]],
    );

    // t-2 opens with a droppable while starved: refused, boundary NOT
    // consumed, redelivery still armed. (Accepting first-of-turn tokens
    // credit-free would let a source bypass flow control by minting
    // turnIds, so refusal is correct - delivery is delayed, not lost.)
    const starved = expectRefused(
      reduce(armed, event({ n: 2, turnId: "t-2", event: { kind: "token", text: "x" } }), 3_000),
    );
    expect(starved.issue).toBe("no-credit");
    expect(starved.state.turn).toEqual({ turnId: "t-1" });

    // Credit resumes; the source resends the SAME n: accepted, boundary
    // observed, armed input delivered.
    const funded = expectAccepted(grantCredit(starved.state, 1, 3_500)).state;
    const boundary = expectAccepted(
      reduce(funded, event({ n: 2, turnId: "t-2", event: { kind: "token", text: "x" } }), 4_000),
    );
    expect(boundary.effects[1]).toEqual({
      type: "send",
      frame: { kind: "input", seq: 3, id: "in-1", text: "go", mode: "queue" },
    });
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

describe("RFC-04 P2: the in-flight input gauge", () => {
  const applied = (id: string): Frame => ({
    kind: "disposition",
    epoch: 1,
    inputId: id,
    outcome: "applied",
  });
  const done = (n: number, turnId: string): Frame =>
    event({ n, turnId, event: { kind: "done", exitCode: 0, cause: "end" } });

  test("rises on the applied disposition (delivery) and falls on the turn's terminal event - never at enqueue or queued", () => {
    let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);

    // Enqueue hands the input to the host, not to the harness: no rise.
    const enqueued = expectAccepted(
      enqueueInput(state, { id: "in-1", text: "go", mode: "queue" }, 1_500),
    );
    expect(enqueued.state.inFlightInputs).toBe(0);
    expect(enqueued.record.queueDepth).toBe(1);
    expect(enqueued.record.inFlightInputs).toBe(0);
    state = enqueued.state;

    // The turn strategy's queued disposition parks the input in lucid's
    // own queue - still not delivered.
    const queued = expectAccepted(
      reduce(state, { kind: "disposition", epoch: 1, inputId: "in-1", outcome: "queued" }, 1_600),
    );
    expect(queued.state.inFlightInputs).toBe(0);
    state = queued.state;

    // Applied is the durable record of delivery: the rise.
    const delivered = expectAccepted(reduce(state, applied("in-1"), 1_700));
    expect(delivered.state.inFlightInputs).toBe(1);
    expect(delivered.record.inFlightInputs).toBe(1);
    // queueDepth has already drained: the input left the disposition queue.
    expect(delivered.record.queueDepth).toBe(0);
    state = delivered.state;

    // Non-terminal events of the turn do not retire it.
    state = drive(state, [
      [event({ n: 1, turnId: "t-1", event: { kind: "message", text: "thinking" } }), 1_800],
    ]);
    expect(state.inFlightInputs).toBe(1);

    // The turn's terminal event retires it.
    const finished = expectAccepted(reduce(state, done(2, "t-1"), 1_900));
    expect(finished.state.inFlightInputs).toBe(0);
  });

  test("the two gauges disagree: applied sends leave queueDepth at zero while the harness is turns behind", () => {
    // The ADR-0007 scenario the RFC's prototype ran: hcn answers every
    // send `started` at once, so inputs are applied and out of the
    // disposition queue before a single turn finishes. queueDepth reports
    // the disposition round-trip (microseconds); only in-flight sees the
    // backlog. This disagreement is why the second gauge exists. The
    // input bound (RFC-04) caps the demonstration at INPUT_QUEUE_MAX
    // concurrent in-flight inputs, so the run goes in batches: fill the
    // backlog to the bound, let the harness finish the batch, repeat.
    let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);
    let sent = 0;
    let ev = 0;
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 1; i <= INPUT_QUEUE_MAX; i++) {
        sent++;
        state = expectAccepted(
          enqueueInput(
            state,
            { id: `in-${sent}`, text: `task ${sent}`, mode: "queue" },
            1_000 + sent,
          ),
        ).state;
        const answered = expectAccepted(reduce(state, applied(`in-${sent}`), 1_000 + sent));
        expect(answered.record.queueDepth).toBe(0);
        expect(answered.record.inFlightInputs).toBe(i);
        state = answered.state;
      }
      expect(state.inFlightInputs).toBe(INPUT_QUEUE_MAX);
      // Turns finish one at a time: the backlog falls one per done event
      // and the next batch starts from an empty one.
      for (let i = 1; i <= INPUT_QUEUE_MAX; i++) {
        ev++;
        state = expectAccepted(reduce(state, done(ev, `t-${ev}`), 2_000 + ev)).state;
      }
      expect(state.inFlightInputs).toBe(0);
    }

    expect(InputLedger.queueDepth(state.inputs)).toBe(0);
    expect(state.inFlightInputs).toBe(0);
  });

  test("a redelivered applied disposition is idempotent for the gauge too - one input, one rise", () => {
    let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);
    state = expectAccepted(
      enqueueInput(state, { id: "in-1", text: "go", mode: "queue" }, 1_500),
    ).state;
    state = expectAccepted(reduce(state, applied("in-1"), 1_600)).state;
    expect(state.inFlightInputs).toBe(1);

    // The crash-redelivery window: the same applied disposition folds again.
    const dupe = expectAccepted(reduce(state, applied("in-1"), 1_700));
    expect(dupe.state.inFlightInputs).toBe(1);
    expect(dupe.record.inFlightInputs).toBe(1);
  });

  test("the gauge is scoped to the attachment: takeover and detach both reset it, so dead turns cannot strand a backlog", () => {
    // A dead incumbent's turns are aborted by the takeover and fenced
    // stale-epoch: their terminal events can never be folded, so anything
    // still counted could never fall out. A successor attaching must not
    // inherit it - otherwise churn would accrue a phantom backlog until
    // INPUT_QUEUE_MAX refuses every send.
    let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);
    state = expectAccepted(
      enqueueInput(state, { id: "in-1", text: "go", mode: "queue" }, 1_500),
    ).state;
    state = expectAccepted(
      enqueueInput(state, { id: "in-2", text: "again", mode: "queue" }, 1_600),
    ).state;
    state = drive(state, [
      [applied("in-1"), 1_700],
      [applied("in-2"), 1_800],
    ]);
    expect(state.inFlightInputs).toBe(2);

    const takeover = expectAccepted(
      reduce(state, attach({ profile: "headless-session" }), 1_000 + LEASE_TTL_MS),
    );
    expect(takeover.state.inFlightInputs).toBe(0);

    // The successor builds its own backlog and detaches: detach resets too.
    let next = expectAccepted(
      enqueueInput(takeover.state, { id: "in-3", text: "fresh", mode: "queue" }, 20_000),
    ).state;
    next = expectAccepted(
      reduce(next, { kind: "disposition", epoch: 2, inputId: "in-3", outcome: "applied" }, 20_100),
    ).state;
    expect(next.inFlightInputs).toBe(1);

    const detached = expectAccepted(
      reduce(next, { kind: "detach", epoch: 2, reason: "shutdown" }, 20_200),
    );
    expect(detached.state.inFlightInputs).toBe(0);
  });

  test("a turn no input opened cannot drive the gauge negative, and refused frames never move it", () => {
    let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);

    // A harness-spontaneous turn ends before any input was delivered.
    const bare = expectAccepted(reduce(state, done(1, "t-1"), 1_500));
    expect(bare.state.inFlightInputs).toBe(0);

    // Two delivered, one retired, then the same done replayed: the replay
    // is refused dupe-n and never applies, so the gauge holds at one.
    state = bare.state;
    state = expectAccepted(
      enqueueInput(state, { id: "in-1", text: "a", mode: "queue" }, 1_600),
    ).state;
    state = expectAccepted(
      enqueueInput(state, { id: "in-2", text: "b", mode: "queue" }, 1_700),
    ).state;
    state = drive(state, [
      [applied("in-1"), 1_800],
      [applied("in-2"), 1_900],
      [done(2, "t-2"), 2_000],
    ]);
    expect(state.inFlightInputs).toBe(1);

    const replayed = expectRefused(reduce(state, done(2, "t-2"), 2_100));
    expect(replayed.issue).toBe("dupe-n");
    expect(replayed.state.inFlightInputs).toBe(1);
  });
});

describe("RFC-04: the input bound", () => {
  const applied = (id: string): Frame => ({
    kind: "disposition",
    epoch: 1,
    inputId: id,
    outcome: "applied",
  });
  const done = (n: number, turnId: string): Frame =>
    event({ n, turnId, event: { kind: "done", exitCode: 0, cause: "end" } });

  /** Attach once, then deliver `count` inputs (enqueue + applied each):
   * the harness has taken them and no turn has finished - exactly the
   * backlog INPUT_QUEUE_MAX bounds. */
  const backlogged = (count: number): ChannelState => {
    let state = drive(fresh(), [[attach({ profile: "headless-session" }), 1_000]]);
    for (let i = 1; i <= count; i++) {
      state = expectAccepted(
        enqueueInput(state, { id: `in-${i}`, text: `task ${i}`, mode: "queue" }, 1_000 + i),
      ).state;
      state = expectAccepted(reduce(state, applied(`in-${i}`), 1_100 + i)).state;
    }
    expect(state.inFlightInputs).toBe(count);
    return state;
  };

  test("the bound is decided: 8, one named constant beside the outbound bound (RFC-04 Open Question 1)", () => {
    // The RFC left the number to implementation once P2's gauge existed.
    // 8 is small on purpose - the reason is recorded at the constant. It
    // imports from the module that owns DROPPABLE_QUEUE_MAX, which is the
    // "one named constant beside the outbound bound" requirement, and
    // pinning the value here makes changing it a visible decision.
    expect(INPUT_QUEUE_MAX).toBe(8);
    expect(INPUT_QUEUE_MAX).toBeLessThan(DROPPABLE_QUEUE_MAX);
  });

  test("a send at the bound is refused input-queue-full: state untouched, no effects, and the record names the condition with both gauges", () => {
    const state = backlogged(INPUT_QUEUE_MAX);
    const result = expectRefused(
      enqueueInput(state, { id: "in-9", text: "one too many", mode: "queue" }, 9_000),
    );

    expect(result.issue).toBe("input-queue-full");
    // A refusal never applies - same state object - and a host refusal
    // sends nothing on the wire: there is nothing to write and nothing
    // to dispatch, so the record is unchanged (the store's refused
    // transitions never write a log line).
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
    expect(result.record.verdict).toBe("refused");
    expect(result.record.issue).toBe("input-queue-full");
    expect(result.record.inputId).toBe("in-9");
    expect(result.record.queueDepth).toBe(0);
    expect(result.record.inFlightInputs).toBe(INPUT_QUEUE_MAX);
  });

  test("the bound reads the in-flight gauge, not queueDepth - the revision-1 trap", () => {
    // hcn answers every send applied at once (ADR 0007), so at the bound
    // the disposition queue is EMPTY: queueDepth reads 0 under exactly
    // the backlog this exists to catch. A bound on queueDepth - what RFC-04
    // revision 1 proposed - never trips; this one refuses.
    const state = backlogged(INPUT_QUEUE_MAX);
    expect(InputLedger.queueDepth(state.inputs)).toBe(0);
    expect(state.inFlightInputs).toBe(INPUT_QUEUE_MAX);
    const refused = expectRefused(
      enqueueInput(state, { id: "in-next", text: "x", mode: "queue" }, 9_000),
    );
    expect(refused.issue).toBe("input-queue-full");
  });

  test("below the bound, sending is unaffected", () => {
    const state = backlogged(INPUT_QUEUE_MAX - 1);
    const ok = expectAccepted(
      enqueueInput(state, { id: "in-next", text: "still room", mode: "queue" }, 9_000),
    );
    expect(ok.state.inputs.some((i) => i.id === "in-next")).toBe(true);
    expect(ok.state.inFlightInputs).toBe(INPUT_QUEUE_MAX - 1);
  });

  test("a finished turn opens a slot: the backlog falls and the next send is accepted again", () => {
    let state = backlogged(INPUT_QUEUE_MAX);
    state = expectAccepted(reduce(state, done(1, "t-1"), 9_000)).state;
    expect(state.inFlightInputs).toBe(INPUT_QUEUE_MAX - 1);
    expectAccepted(enqueueInput(state, { id: "in-next", text: "room now", mode: "queue" }, 9_100));
  });

  test("the bound holds on durable state alone: a lapsed lease opens no slot, the takeover that zeroes the gauge does", () => {
    // No writer is attached - the lease lapsed without a takeover - yet
    // the record still says 8 turns are unanswered. The bound is policy
    // on durable state, not on live writers, so the send still refuses.
    // The successor's attach resets the gauge (P2), and only that opens
    // the door again - which is also what keeps a dead incumbent's
    // backlog from fencing the conversation forever.
    const state = backlogged(INPUT_QUEUE_MAX);
    const lapsed = 1_000 + LEASE_TTL_MS + 5_000;
    expect(isLive(state, lapsed)).toBe(false);
    expectRefused(
      enqueueInput(state, { id: "in-next", text: "no one is driving", mode: "queue" }, lapsed),
    );

    const takeover = expectAccepted(reduce(state, attach({ profile: "headless-session" }), lapsed));
    expect(takeover.state.inFlightInputs).toBe(0);
    expectAccepted(
      enqueueInput(
        takeover.state,
        { id: "in-next", text: "fresh writer", mode: "queue" },
        lapsed + 10,
      ),
    );
  });

  test("a reused id still answers input-id-reused at the bound - a retried send is a redelivery question, not a capacity one", () => {
    const state = backlogged(INPUT_QUEUE_MAX);
    const result = expectRefused(
      enqueueInput(state, { id: "in-1", text: "retry", mode: "queue" }, 9_000),
    );
    expect(result.issue).toBe("input-id-reused");
  });
});

describe("RFC-03: the record remembers which harness held the session", () => {
  const identity = (sessionId: string) => ({ kind: "identity", sessionId });
  /** Attach, announce an identity, detach - one harness's turn at the record. */
  // `at` advances past the previous lease: a takeover is the only way a
  // second harness gets the record, which is exactly the sequence under test.
  const heldBy = (
    start: ReturnType<typeof fresh>,
    harness: "claude" | "codex" | "pi" | "muse",
    sessionId: string,
    at: number,
    n = 1,
  ) => {
    const a = reduce(start, attach({ profile: "headless-session", harness }), at);
    if (a.verdict !== "accepted") throw new Error(`attach refused: ${a.issue}`);
    const s = a.state;
    const e = reduce(
      s,
      {
        kind: "event",
        epoch: s.epoch,
        n,
        turnId: `t-${harness}-${at}-${n}`,
        event: identity(sessionId),
      },
      at,
    );
    if (e.verdict !== "accepted") throw new Error(`event refused: ${e.issue}`);
    return e.state;
  };

  test("a headless attach without a harness is refused; interactive without one is fine", () => {
    const noHarness = reduce(
      fresh(),
      {
        ...(attach({ profile: "headless-session" }) as Record<string, unknown>),
        harness: undefined,
      } as never,
      1_000,
    );
    expect(noHarness.verdict).toBe("refused");
    if (noHarness.verdict === "refused") expect(noHarness.issue).toBe("invalid-grant");

    // interactive never resumes, so it is not required to say.
    const interactive = reduce(fresh(), attach({ profile: "interactive" }), 1_000);
    expect(interactive.verdict).toBe("accepted");
  });

  test("attaching the same harness is told the session it last held", () => {
    const afterClaude = heldBy(fresh(), "claude", "claude-session-1", 1_000);
    const back = reduce(
      afterClaude,
      attach({ profile: "headless-session", harness: "claude" }),
      20_000,
    );
    expect(back.verdict).toBe("accepted");
    if (back.verdict !== "accepted") return;
    const ok = back.effects.find((e) => e.type === "send" && e.frame.kind === "attach-ok") as
      | { frame: { resumeSessionId?: string } }
      | undefined;
    expect(ok?.frame.resumeSessionId).toBe("claude-session-1");
  });

  test("attaching a DIFFERENT harness is told nothing, even though the record has a session", () => {
    // The failure this exists to prevent: pi must not be handed claude's id.
    const afterClaude = heldBy(fresh(), "claude", "claude-session-1", 1_000);
    const pi = reduce(afterClaude, attach({ profile: "headless-session", harness: "pi" }), 20_000);
    expect(pi.verdict).toBe("accepted");
    if (pi.verdict !== "accepted") return;
    const ok = pi.effects.find((e) => e.type === "send" && e.frame.kind === "attach-ok") as
      | { frame: { resumeSessionId?: string } }
      | undefined;
    expect(ok?.frame.resumeSessionId).toBeUndefined();
  });

  test("attribution survives the epoch increment that discards the attachment", () => {
    // ChannelState keeps only the CURRENT attachment, so this is the case a
    // search over state would get wrong: claude's session must still be
    // findable after pi has attached and detached in between.
    let s = heldBy(fresh(), "claude", "claude-session-1", 1_000);
    s = heldBy(s, "pi", "pi-session-1", 100_000);
    expect(s.harnessSessions).toEqual({
      claude: "claude-session-1",
      pi: "pi-session-1",
    });

    const backToClaude = reduce(
      s,
      attach({ profile: "headless-session", harness: "claude" }),
      200_000,
    );
    if (backToClaude.verdict !== "accepted") throw new Error("attach refused");
    const ok = backToClaude.effects.find(
      (e) => e.type === "send" && e.frame.kind === "attach-ok",
    ) as { frame: { resumeSessionId?: string } } | undefined;
    expect(ok?.frame.resumeSessionId).toBe("claude-session-1");
  });

  test("the newest identity of that harness wins", () => {
    let s = heldBy(fresh(), "claude", "old-session", 1_000);
    s = heldBy(s, "claude", "new-session", 100_000);
    expect(s.harnessSessions.claude).toBe("new-session");
  });

  test("an interactive attachment attributes nothing", () => {
    const a = reduce(fresh(), attach({ profile: "interactive" }), 1_000);
    if (a.verdict !== "accepted") throw new Error("attach refused");
    const e = reduce(
      a.state,
      { kind: "event", epoch: a.state.epoch, n: 1, turnId: "t1", event: identity("human-session") },
      1_000,
    );
    if (e.verdict !== "accepted") throw new Error("event refused");
    // lucid does not own that process and must never offer its id to anyone.
    expect(e.state.harnessSessions).toEqual({});
  });
});
