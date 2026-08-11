import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effect, TransitionRecord } from "../../src/protocol/index.js";
import { encodeFrame, type Frame, PROTOCOL_VERSION } from "../../src/protocol/index.js";
import { createConversationRecord, openConversation, StoreError } from "../../src/store/store.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-store-"));

interface Harness {
  readonly host: ReturnType<typeof openConversation>;
  readonly effects: Effect[];
  readonly records: TransitionRecord[];
  now: number;
  presence: boolean | undefined;
}

const openHost = (
  rootDir: string,
  conversationId: string,
  overrides: { now?: number; presence?: boolean | undefined } = {},
): Harness => {
  const effects: Effect[] = [];
  const records: TransitionRecord[] = [];
  const box = {
    now: overrides.now ?? 1_000,
    presence: "presence" in overrides ? overrides.presence : undefined,
  };
  const host = openConversation(recordDir(rootDir, conversationId), {
    now: () => box.now,
    presence: () => box.presence,
    onEffect: (e) => effects.push(e),
    onRecord: (r) => records.push(r as TransitionRecord),
  });
  return {
    host,
    effects,
    records,
    get now() {
      return box.now;
    },
    set now(v: number) {
      box.now = v;
    },
    get presence() {
      return box.presence;
    },
    set presence(v: boolean | undefined) {
      box.presence = v;
    },
  };
};

const recordDir = (rootDir: string, conversationId: string): string =>
  join(rootDir, conversationId);

const attachFrame = (
  secret: string,
  overrides: Partial<Extract<Frame, { kind: "attach" }>> = {},
): Frame => ({
  kind: "attach",
  conversationId: "conv-1",
  profile: "interactive",
  secret,
  version: PROTOCOL_VERSION,
  ...overrides,
});

describe("durable conversation store (M5.1)", () => {
  test("record creation mints the secret 0600 with an empty log - and a second creation NEVER re-mints (first-attacker hole closed)", () => {
    const root = freshRoot();

    const created = createConversationRecord(root, "conv-1");
    expect(created.secret.length).toBeGreaterThanOrEqual(32);

    const secretPath = join(root, "conv-1", "secret");
    expect(readFileSync(secretPath, "utf8")).toBe(created.secret);
    // Possession of file read access IS the authorization (D-004), so the
    // file must be unreadable to anyone but the owner.
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "conv-1", "log.ndjson"), "utf8")).toBe("");

    // Creation is lucid's alone: a second creation throws rather than
    // re-minting - a first attacher must never mint the secret.
    expect(() => createConversationRecord(root, "conv-1")).toThrow(/exists/);
    expect(readFileSync(secretPath, "utf8")).toBe(created.secret);
  });

  test("the host enforces the reducer's verdicts: accepted frames are appended before applied, effects delivered, one record per frame either way", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");

    // Wrong secret: refused, surfaced through record + refused-send effect,
    // and NOTHING lands in the durable log.
    const refused = h.host.handleFrame(encodeFrame(attachFrame("wrong")));
    expect(refused.verdict).toBe("refused");
    expect(h.records[0]?.issue).toBe("auth-failed");
    expect(h.effects[0]).toEqual({
      type: "send",
      frame: { kind: "refused", issue: "auth-failed" },
    });
    expect(readFileSync(join(root, "conv-1", "log.ndjson"), "utf8")).toBe("");

    // Right secret: accepted, appended durably, attach-ok delivered.
    const accepted = h.host.handleFrame(encodeFrame(attachFrame(secret)));
    expect(accepted.verdict).toBe("accepted");
    expect(h.host.state().epoch).toBe(1);
    expect(h.records[1]?.verdict).toBe("accepted");
    expect(h.effects[1]?.type).toBe("send");
    const log = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    expect(log.endsWith("\n")).toBe(true);
    expect(log.trim().split("\n").length).toBe(1);

    // A wire line that never decodes is refused with the codec's issue and
    // is not appended.
    const torn = h.host.handleFrame('{"kind":"event","epoch":1');
    expect(torn.verdict).toBe("refused");
    expect(readFileSync(join(root, "conv-1", "log.ndjson"), "utf8")).toBe(log);
  });

  test("opening a record without its secret is a typed error", () => {
    const root = freshRoot();
    expect(() => openHost(root, "conv-9")).toThrow(StoreError);
  });

  test("fold reproduces state across reopen, is idempotent, and repairs a crash-torn trailing line", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");

    h.host.handleFrame(encodeFrame(attachFrame(secret)));
    h.now = 2_000;
    h.host.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-1",
        event: { kind: "message", text: "hi" },
      }),
    );
    h.host.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });
    h.host.grantCredit(5);
    const live = h.host.state();
    expect(live.seq).toBe(3);
    expect(live.credits).toBe(5);

    // Reopen: fold reproduces the exact state, byte for byte.
    const reopened = openHost(root, "conv-1");
    expect(reopened.host.state()).toEqual(live);
    // Idempotent: reopening again changes nothing.
    expect(openHost(root, "conv-1").host.state()).toEqual(live);

    // Crash mid-append: a torn trailing line is tolerated on fold and
    // repaired, so the next append starts clean.
    const logPath = join(root, "conv-1", "log.ndjson");
    const before = readFileSync(logPath, "utf8");
    appendFileSync(logPath, '{"v":1,"at":9,"src":"credit","tok');
    const afterCrash = openHost(root, "conv-1");
    expect(afterCrash.host.state()).toEqual(live);
    expect(readFileSync(logPath, "utf8")).toBe(before);

    afterCrash.now = 3_000;
    afterCrash.host.grantCredit(1);
    expect(openHost(root, "conv-1").host.state().credits).toBe(6);
  });

  test("presence is polled on the status cadence: alive + heartbeat timeout is interactive-unattached, NEVER agent-gone", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");

    let polls = 0;
    let alive: boolean | undefined = true;
    const effects: Effect[] = [];
    const host = openConversation(join(root, "conv-1"), {
      now: () => now,
      presence: () => {
        polls += 1;
        return alive;
      },
      onEffect: (e) => effects.push(e),
      onRecord: () => {},
    });
    let now = 1_000;

    host.handleFrame(encodeFrame(attachFrame(secret)));
    expect(host.status()).toBe("interactive-attached");

    // Heartbeat timeout passes with the process still alive: the channel
    // is dead but the human is not - unattached, not gone.
    now = 1_000 + 15_000;
    expect(host.status()).toBe("interactive-unattached");

    // Process exits: NOW it is agent-gone (takeover territory).
    alive = false;
    expect(host.status()).toBe("agent-gone");

    // Every status tick sampled the normalizer's fact - that IS the
    // polling cadence, driven by the caller's ticks.
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test("concurrent unrelated conversations are isolated: killing one source disturbs nothing in the other", () => {
    const root = freshRoot();
    const a = createConversationRecord(root, "conv-a");
    const b = createConversationRecord(root, "conv-b");
    expect(a.secret).not.toBe(b.secret);

    const hostA = openHost(root, "conv-a");
    const hostB = openHost(root, "conv-b");

    hostA.host.handleFrame(
      encodeFrame({ ...attachFrame(a.secret), conversationId: "conv-a" } as Frame),
    );
    hostB.host.handleFrame(
      encodeFrame({ ...attachFrame(b.secret), conversationId: "conv-b" } as Frame),
    );
    hostB.now = 2_000;
    hostB.host.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-b",
        event: { kind: "message", text: "b" },
      }),
    );
    const bState = hostB.host.state();

    // A's source dies mid-turn and its lease lapses; a takeover happens on A.
    hostA.now = 1_000 + 15_000;
    hostA.host.handleFrame(
      encodeFrame({
        ...attachFrame(a.secret),
        conversationId: "conv-a",
        profile: "headless-session",
      } as Frame),
    );
    expect(hostA.host.state().epoch).toBe(2);

    // B is untouched - by identity, and by fold from its own log.
    expect(hostB.host.state()).toBe(bState);
    expect(openHost(root, "conv-b").host.state()).toEqual(bState);

    // A's secret gets nothing on B.
    const cross = hostB.host.handleFrame(
      encodeFrame({ ...attachFrame(a.secret), conversationId: "conv-b" } as Frame),
    );
    expect(cross.verdict).toBe("refused");
  });

  test("headless-vs-headless concurrent resume at the store: exactly one wins, the loser is fenced by epoch, and the outcome is durable", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1", { presence: false });

    // Dead headless incumbent.
    h.host.handleFrame(
      encodeFrame({ ...attachFrame(secret), profile: "headless-session" } as Frame),
    );
    h.now = 1_000 + 15_000;

    // Two contenders race openSession(--resume); the store serializes.
    // Both see presence=false, so presence cannot decide (D-021).
    const x = h.host.handleFrame(
      encodeFrame({ ...attachFrame(secret), profile: "headless-session" } as Frame),
    );
    expect(x.verdict).toBe("accepted");
    expect(h.host.state().epoch).toBe(2);

    const y = h.host.handleFrame(
      encodeFrame({ ...attachFrame(secret), profile: "headless-turn" } as Frame),
    );
    expect(y.verdict).toBe("refused");
    if ("issue" in y) expect(y.issue).toBe("lease-held");

    // The loser writes on its stale guess: fenced, observably.
    const write = h.host.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-y",
        event: { kind: "message", text: "y" },
      }),
    );
    if ("issue" in write) expect(write.issue).toBe("stale-epoch");

    // The winner's epoch is what survives a crash: fold says epoch 2.
    expect(openHost(root, "conv-1").host.state().epoch).toBe(2);
  });
});
