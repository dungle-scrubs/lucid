import { describe, expect, test } from "bun:test";
import { decideAction } from "../../src/modes/controller.js";
import { ATTACH_GRACE_MS, channelStatus, HEARTBEAT_MS } from "../../src/protocol/liveness.js";
import { LEASE_RENEW_EVERY_MS, LEASE_TTL_MS, reduce } from "../../src/protocol/reducer.js";
import { attach, expectAccepted, fresh } from "./helpers.js";

describe("liveness + state machine (M4.4)", () => {
  test("the five conversation states derive from profile, lease liveness, and presence - and the grace constants ARE the lease clock, in one module", () => {
    // PLAN's liveness names alias the lease clock: one module, one clock.
    expect(HEARTBEAT_MS).toBe(LEASE_RENEW_EVERY_MS);
    expect(ATTACH_GRACE_MS).toBe(LEASE_TTL_MS);

    // Live channel: status is the attached profile's state.
    const interactive = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    expect(channelStatus(interactive, 2_000, { processAlive: true })).toBe("interactive-attached");

    const session = expectAccepted(
      reduce(fresh(), attach({ profile: "headless-session" }), 1_000),
    ).state;
    expect(channelStatus(session, 2_000, { processAlive: true })).toBe("headless-session");

    const turn = expectAccepted(reduce(fresh(), attach({ profile: "headless-turn" }), 1_000)).state;
    expect(channelStatus(turn, 2_000, { processAlive: true })).toBe("headless-turn");

    // Dead channel: presence corroborates unattached vs gone - it never
    // proves a channel, so it cannot make a dead channel look attached.
    const expired = 1_000 + ATTACH_GRACE_MS;
    expect(channelStatus(interactive, expired, { processAlive: true })).toBe(
      "interactive-unattached",
    );
    expect(channelStatus(interactive, expired, { processAlive: false })).toBe("agent-gone");

    // Never attached at all: the same corroboration split.
    expect(channelStatus(fresh(), 1_000, { processAlive: true })).toBe("interactive-unattached");
    expect(channelStatus(fresh(), 1_000, { processAlive: false })).toBe("agent-gone");
  });

  test("heartbeat timeout decides, exactly at the grace boundary - heartbeats hold the channel attached indefinitely", () => {
    let state = expectAccepted(reduce(fresh(), attach(), 1_000)).state;

    // An hour of nothing but heartbeats: still attached the whole way.
    for (let at = 1_000 + HEARTBEAT_MS; at <= 3_600_000; at += HEARTBEAT_MS) {
      state = expectAccepted(reduce(state, { kind: "heartbeat", epoch: 1 }, at)).state;
      expect(channelStatus(state, at, { processAlive: true })).toBe("interactive-attached");
    }

    // The last renewal set expires; the flip is exact: one tick before the
    // grace boundary the channel is attached, at the boundary it is not.
    const expires = state.attachment?.lease.expires ?? 0;
    expect(channelStatus(state, expires - 1, { processAlive: true })).toBe("interactive-attached");
    expect(channelStatus(state, expires, { processAlive: true })).toBe("interactive-unattached");
    expect(channelStatus(state, expires, { processAlive: false })).toBe("agent-gone");
  });

  test("headless takeover is REFUSED while presence holds - the human's process is alive, only the channel died", () => {
    const attached = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    const expired = 1_000 + ATTACH_GRACE_MS;

    // interactive-unattached (presence corroborates the process alive):
    // a headless contender may NOT steal the conversation.
    const refusedSession = reduce(attached, attach({ profile: "headless-session" }), expired, {
      presence: { processAlive: true },
    });
    expect(refusedSession.verdict).toBe("refused");
    if (refusedSession.verdict === "refused") {
      expect(refusedSession.issue).toBe("presence-holds");
      expect(refusedSession.state).toBe(attached);
    }
    expect(
      reduce(attached, attach({ profile: "headless-turn" }), expired, {
        presence: { processAlive: true },
      }).verdict,
    ).toBe("refused");

    // agent-gone: headless takeover is exactly what should happen.
    const takeover = expectAccepted(
      reduce(attached, attach({ profile: "headless-session" }), expired, {
        presence: { processAlive: false },
      }),
    );
    expect(takeover.state.epoch).toBe(2);

    // Presence UNKNOWN (host could not corroborate): presence never proves
    // a channel and never blocks alone - epoch fencing is the defense
    // (D-021), so the attach proceeds.
    expectAccepted(reduce(attached, attach({ profile: "headless-session" }), expired));

    // The human's own adapter re-attaching is never presence-gated.
    expectAccepted(reduce(attached, attach(), expired, { presence: { processAlive: true } }));
  });

  test("presence fences CONTENDERS, never the incumbent's own recovery: a dead headless channel re-attaches even while an interactive process lives", () => {
    // Lucid-owned headless-session incumbent; its lease lapses.
    const headless = expectAccepted(
      reduce(fresh(), attach({ profile: "headless-session" }), 1_000),
    ).state;
    const expired = 1_000 + ATTACH_GRACE_MS;

    // An interactive process being alive somewhere must NOT strand the
    // headless runner: presence guards interactively-held conversations,
    // and this one was headless-held.
    const recovered = expectAccepted(
      reduce(headless, attach({ profile: "headless-session" }), expired, {
        presence: { processAlive: true },
      }),
    );
    expect(recovered.state.epoch).toBe(2);

    // A NEVER-attached conversation with a live interactive process is
    // interactively held in spirit: headless attach refused there.
    const virgin = reduce(fresh(), attach({ profile: "headless-session" }), 1_000, {
      presence: { processAlive: true },
    });
    expect(virgin.verdict).toBe("refused");
    if (virgin.verdict === "refused") expect(virgin.issue).toBe("presence-holds");

    // Ordering: while the lease is HELD, the refusal is lease-held - the
    // presence gate only speaks for dead channels.
    const live = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    const contender = reduce(live, attach({ profile: "headless-session" }), 2_000, {
      presence: { processAlive: true },
    });
    expect(contender.verdict).toBe("refused");
    if (contender.verdict === "refused") expect(contender.issue).toBe("lease-held");
  });

  test("attach records carry the presence dimension, so a corroborated takeover and a blind one are distinguishable in the log", () => {
    const attached = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    const expired = 1_000 + ATTACH_GRACE_MS;

    const corroborated = expectAccepted(
      reduce(attached, attach({ profile: "headless-session" }), expired, {
        presence: { processAlive: false },
      }),
    );
    expect(corroborated.record.presence).toBe("gone");

    const blind = expectAccepted(
      reduce(attached, attach({ profile: "headless-session" }), expired),
    );
    expect(blind.record.presence).toBe("unknown");

    const fenced = reduce(attached, attach({ profile: "headless-session" }), expired, {
      presence: { processAlive: true },
    });
    if (fenced.verdict === "refused") expect(fenced.record.presence).toBe("alive");
    expect(fenced.verdict).toBe("refused");
  });

  test("D-021 concurrent headless-resume oracle: two headless contenders, both seeing presence=false - exactly one wins, loser refused by epoch, not luck", () => {
    // A dead conversation (headless incumbent's lease lapsed). Two headless
    // resumers race; presence corroborates nothing for either (both see
    // the interactive process gone), so presence CANNOT decide - epoch
    // fencing is the only defense, and it suffices.
    const dead = expectAccepted(
      reduce(fresh(), attach({ profile: "headless-session" }), 1_000),
    ).state;
    const expired = 1_000 + ATTACH_GRACE_MS;
    const noOne = { presence: { processAlive: false } } as const;

    // The reducer serializes: X lands first and wins the next epoch.
    const x = expectAccepted(reduce(dead, attach({ profile: "headless-session" }), expired, noOne));
    expect(x.state.epoch).toBe(2);

    // Y lands a tick later with the same correct secret and the same
    // presence=false: refused deterministically - X now holds the lease.
    const y = reduce(x.state, attach({ profile: "headless-turn" }), expired + 1, noOne);
    expect(y.verdict).toBe("refused");
    if (y.verdict === "refused") expect(y.issue).toBe("lease-held");

    // Whatever epoch Y presents, it is not current: every write is fenced.
    for (const epoch of [1, 3]) {
      const write = reduce(
        x.state,
        { kind: "event", epoch, n: 1, turnId: "t-y", event: { kind: "message", text: "y" } },
        expired + 2,
      );
      expect(write.verdict).toBe("refused");
      if (write.verdict === "refused")
        expect(write.issue).toBe(epoch < 2 ? "stale-epoch" : "future-epoch");
    }

    // X is the one writer.
    expectAccepted(
      reduce(
        x.state,
        { kind: "event", epoch: 2, n: 1, turnId: "t-x", event: { kind: "message", text: "x" } },
        expired + 3,
      ),
    );
  });

  test("handoff is legal only at turn boundaries: a clean yield handoff aborts nothing; lease-expiry takeover is the one mid-turn exception", () => {
    // Turn ends (the source detaches at the boundary, turn already null in
    // this flow); successor attaches: NO abort anywhere in the handoff.
    const attached = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    const yielded = expectAccepted(
      reduce(attached, { kind: "detach", epoch: 1, reason: "yield" }, 2_000),
    );
    expect(yielded.effects).toEqual([]);

    const successor = expectAccepted(
      reduce(yielded.state, attach({ profile: "headless-session" }), 3_000, {
        presence: { processAlive: false },
      }),
    );
    expect(successor.effects.every((e) => e.type !== "abort-turn")).toBe(true);
    expect(successor.state.epoch).toBe(2);

    // (D-020) The mid-flight exactly-once handoff oracle does NOT live at
    // this layer - the reducer has no durable replay buffer to prove
    // ordered exactly-once delivery. M4.4 proves heartbeat/lease/epoch/
    // state only; the full oracle lands in M5.4 over the store.
  });
});

describe("a lapsed lease does not change which profile is attached", () => {
  test("an idle headless driver reads as headless, not as an interactive session", () => {
    const session = expectAccepted(
      reduce(fresh(), attach({ profile: "headless-session" }), 1_000),
    ).state;
    const turn = expectAccepted(reduce(fresh(), attach({ profile: "headless-turn" }), 1_000)).state;
    const expired = 1_000 + ATTACH_GRACE_MS;

    // The lease lapses after silence, and waiting for a person to type is
    // exactly that. The driver is alive and holding the lock the whole time.
    expect(channelStatus(session, expired, { processAlive: true })).toBe("headless-session");
    expect(channelStatus(turn, expired, { processAlive: true })).toBe("headless-turn");
  });

  test("and the controller therefore delivers rather than waiting for a re-attach", () => {
    const session = expectAccepted(
      reduce(fresh(), attach({ profile: "headless-session" }), 1_000),
    ).state;
    const expired = 1_000 + ATTACH_GRACE_MS;
    const status = channelStatus(session, expired, { processAlive: true });
    // `interactive-unattached` means "a living human session, wait for it".
    // A headless driver is not going to re-attach: it is already attached.
    expect(decideAction(status)).toMatchObject({ action: "deliver", takeover: false });
  });

  test("an interactive attachment is unchanged — that is what the name is for", () => {
    const interactive = expectAccepted(reduce(fresh(), attach(), 1_000)).state;
    const expired = 1_000 + ATTACH_GRACE_MS;
    expect(channelStatus(interactive, expired, { processAlive: true })).toBe(
      "interactive-unattached",
    );
  });

  test("a dead process is gone whatever was attached", () => {
    const session = expectAccepted(
      reduce(fresh(), attach({ profile: "headless-session" }), 1_000),
    ).state;
    const expired = 1_000 + ATTACH_GRACE_MS;
    // The lock is kernel-released on death, so this is the honest answer and
    // the one that lets a successor take over.
    expect(channelStatus(session, expired, { processAlive: false })).toBe("agent-gone");
  });

  test("never attached at all is still interactive-unattached", () => {
    // No profile to preserve, and a live process with no attachment is the
    // case the name was written for.
    expect(channelStatus(fresh(), 1_000, { processAlive: true })).toBe("interactive-unattached");
  });
});
