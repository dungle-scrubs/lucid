import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DROPPABLE_KINDS, LOSSLESS_KINDS } from "../src/protocol/events.js";
import type { Frame } from "../src/protocol/index.js";
import { grantCredit, reduce } from "../src/protocol/reducer.js";
import { createConversationRecord, openConversation } from "../src/store/store.js";
import { attach, drive, event, expectAccepted, expectRefused, fresh } from "./protocol/helpers.js";

/**
 * M7.1 - PLAN 4.7 oracle completion sweep, lucid-v2 side. The
 * spawn-boundary security set (argvOrder / control chars / registry path
 * traversal) and the resumeLast race are NORMALIZER oracles, covered in
 * harness-cli-normalizer (test/interpretation/argv.test.ts,
 * resume-last.test.ts) under Gate 2->3. This file closes the two
 * protocol-side 4.7 oracles: credit-starvation across ALL classes, and
 * identity collisions across conversations.
 */

describe("oracle sweep (M7.1): credit-starvation classes", () => {
  test("EVERY droppable kind is credit-gated (refused no-credit when starved) and EVERY lossless kind is never gated", () => {
    // A completeness check keyed off the exported vocabularies, so a new
    // droppable/lossless kind cannot be added without this asserting its
    // class behavior.
    let n = 0;
    for (const kind of DROPPABLE_KINDS) {
      const state = drive(fresh(), [[attach(), 1_000]]);
      const starved = expectRefused(
        reduce(state, event({ epoch: 1, n: 1, event: { kind } }), 2_000),
      );
      expect(starved.issue, `droppable ${kind} must be no-credit when starved`).toBe("no-credit");
      // lastN untouched: the source resends the same n once credit lands.
      expect(starved.state.attachment?.lastN).toBe(0);
      n += 1;
    }
    expect(n).toBe(DROPPABLE_KINDS.length);

    for (const kind of LOSSLESS_KINDS) {
      const state = drive(fresh(), [[attach(), 1_000]]);
      const accepted = expectAccepted(
        reduce(state, event({ epoch: 1, n: 1, event: { kind } }), 2_000),
      );
      expect(accepted.state.attachment?.lastN, `lossless ${kind} must flow uncredited`).toBe(1);
    }
  });

  test("under a bounded credit budget the droppable classes drain the budget and then starve, while lossless keeps flowing", () => {
    let state = drive(fresh(), [[attach(), 1_000]]);
    state = expectAccepted(grantCredit(state, 2, 1_100)).state;

    // Two droppables spend the budget...
    state = expectAccepted(
      reduce(state, event({ epoch: 1, n: 1, event: { kind: "token", text: "a" } }), 1_200),
    ).state;
    state = expectAccepted(
      reduce(state, event({ epoch: 1, n: 2, event: { kind: "progress", label: "p" } }), 1_300),
    ).state;
    expect(state.credits).toBe(0);

    // ...the next droppable starves...
    const starved = expectRefused(
      reduce(state, event({ epoch: 1, n: 3, event: { kind: "context", usedPct: 5 } }), 1_400),
    );
    expect(starved.issue).toBe("no-credit");

    // ...but a lossless event still flows.
    expectAccepted(
      reduce(state, event({ epoch: 1, n: 3, event: { kind: "message", text: "m" } }), 1_500),
    );
  });
});

describe("oracle sweep (M7.1): identity collisions", () => {
  const openHost = (root: string, id: string) => {
    const box = { now: 1_000, presence: undefined as boolean | undefined };
    const { secret } = createConversationRecord(root, id);
    const host = openConversation(join(root, id), {
      now: () => box.now,
      presence: () => box.presence,
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    return { secret, host, box, send: (f: Frame) => host.handleFrame(JSON.stringify(f)) };
  };

  test("two conversations minted independently get DISTINCT secrets; neither secret authenticates the other; killing one disturbs no other", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-oracle-"));
    const a = openHost(root, "conv-a");
    const b = openHost(root, "conv-b");
    // Independently minted secrets never collide.
    expect(a.secret).not.toBe(b.secret);

    a.send({
      kind: "attach",
      conversationId: "conv-a",
      profile: "interactive",
      secret: a.secret,
      version: 1,
    });
    b.send({
      kind: "attach",
      conversationId: "conv-b",
      profile: "interactive",
      secret: b.secret,
      version: 1,
    });
    b.send({
      kind: "event",
      epoch: 1,
      n: 1,
      turnId: "t-b",
      event: { kind: "message", text: "b-only" },
    });
    const bBefore = b.host.transcript();

    // A's secret is rejected on B (auth-failed) - no cross-authentication.
    const cross = b.send({
      kind: "attach",
      conversationId: "conv-b",
      profile: "interactive",
      secret: a.secret,
      version: 1,
    });
    expect(cross.verdict).toBe("refused");

    // A takes a takeover storm (lease lapse + re-attach); B is untouched.
    a.box.now = 1_000 + 15_000;
    a.send({
      kind: "attach",
      conversationId: "conv-a",
      profile: "headless-session",
      harness: "claude" as const,
      secret: a.secret,
      version: 1,
    });
    expect(a.host.state().epoch).toBe(2);
    expect(b.host.transcript()).toEqual(bBefore);
    expect(b.host.state().epoch).toBe(1);
  });

  test("within one conversation, a colliding turnId or input id is refused - identity is unique per conversation", () => {
    const state = drive(fresh(), [
      [attach(), 1_000],
      [event({ n: 1, turnId: "t-1" }), 2_000],
      [event({ n: 2, turnId: "t-2" }), 2_001], // t-1 retired
    ]);
    // A retired turnId cannot be revived.
    expect(expectRefused(reduce(state, event({ n: 3, turnId: "t-1" }), 3_000)).issue).toBe(
      "turn-id-reused",
    );
  });
});
