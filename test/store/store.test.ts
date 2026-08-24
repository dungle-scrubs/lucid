import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effect } from "../../src/protocol/index.js";
import { encodeFrame, type Frame, queueDepth } from "../../src/protocol/index.js";
import {
  createConversationRecord,
  type HostRecord,
  openConversation,
  StoreError,
  viewConversation,
} from "../../src/store/store.js";
import { attach, event } from "../protocol/helpers.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-store-"));

interface Harness {
  readonly host: ReturnType<typeof openConversation>;
  readonly effects: Effect[];
  readonly records: HostRecord[];
  now: number;
  presence: boolean | undefined;
  /** The R2 executor-lease box: flip it to simulate acquiring or losing
   * the presence lock without a real flock. */
  lease: boolean;
}

const openHost = (
  rootDir: string,
  conversationId: string,
  overrides: { now?: number; presence?: boolean | undefined; lease?: boolean } = {},
): Harness => {
  const effects: Effect[] = [];
  const records: HostRecord[] = [];
  const box = {
    now: overrides.now ?? 1_000,
    presence: "presence" in overrides ? overrides.presence : undefined,
    lease: overrides.lease ?? true,
  };
  const host = openConversation(recordDir(rootDir, conversationId), {
    now: () => box.now,
    presence: () => box.presence,
    executorLease: () => box.lease,
    onEffect: (e) => effects.push(e),
    onRecord: (r) => records.push(r),
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
    get lease() {
      return box.lease;
    },
    set lease(v: boolean) {
      box.lease = v;
    },
  };
};

const recordDir = (rootDir: string, conversationId: string): string =>
  join(rootDir, conversationId);

const attachFrame = (
  secret: string,
  overrides: Partial<Extract<Frame, { kind: "attach" }>> = {},
): Frame => attach({ secret, ...overrides });

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
    expect(h.records[0]?.verdict).toBe("recovered");
    if ("issue" in (h.records[1] ?? {}))
      expect((h.records[1] as { issue: string }).issue).toBe("auth-failed");
    expect(h.effects[0]).toEqual({
      type: "send",
      frame: { kind: "refused", issue: "auth-failed" },
    });
    expect(readFileSync(join(root, "conv-1", "log.ndjson"), "utf8")).toBe("");

    // Right secret: accepted, appended durably, attach-ok delivered.
    const accepted = h.host.handleFrame(encodeFrame(attachFrame(secret)));
    expect(accepted.verdict).toBe("accepted");
    expect(h.host.state().epoch).toBe(1);
    expect(h.records[2]?.verdict).toBe("accepted");
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

  test("the in-flight input gauge survives the fold: a reopened record reports the same backlog (RFC-04 P2)", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");

    // The ADR-0007 backlog shape: three sends answered applied at once, one
    // turn finished. queueDepth is zero throughout; the backlog exists only
    // in the in-flight count, so this is the quantity a reopen must reproduce.
    h.host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    for (const [i, id] of ["in-1", "in-2", "in-3"].entries()) {
      h.now = 2_000 + i;
      h.host.enqueueInput({ id, text: `task ${i}`, mode: "queue" });
      h.host.handleFrame(
        encodeFrame({ kind: "disposition", epoch: 1, inputId: id, outcome: "applied" }),
      );
    }
    h.now = 3_000;
    h.host.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-1",
        event: { kind: "done", exitCode: 0, cause: "end" },
      }),
    );

    const live = h.host.state();
    expect(live.inFlightInputs).toBe(2);
    expect(queueDepth(live.inputs)).toBe(0);

    // Reopen: the fold replays the same dispositions and terminal events,
    // so the successor reading the record sees the true backlog, not zero.
    const reopened = openHost(root, "conv-1");
    expect(reopened.host.state()).toEqual(live);
    expect(reopened.host.state().inFlightInputs).toBe(2);
    expect(queueDepth(reopened.host.state().inputs)).toBe(0);
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
      executorLease: () => true,
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
      encodeFrame(
        attachFrame(a.secret, {
          conversationId: "conv-a",
          profile: "headless-session",
        }) as Frame,
      ),
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
    h.host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" }) as Frame));
    h.now = 1_000 + 15_000;

    // Two contenders race openSession(--resume); the store serializes.
    // Both see presence=false, so presence cannot decide (D-021).
    const x = h.host.handleFrame(
      encodeFrame(attachFrame(secret, { profile: "headless-session" }) as Frame),
    );
    expect(x.verdict).toBe("accepted");
    expect(h.host.state().epoch).toBe(2);

    const y = h.host.handleFrame(
      encodeFrame({ ...attachFrame(secret), profile: "headless-turn" } as Frame),
    );
    expect(y.verdict).toBe("refused");
    expect("issue" in y && y.issue).toBe("lease-held");

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
    expect(write.verdict).toBe("refused");
    expect("issue" in write && write.issue).toBe("stale-epoch");

    // The winner's epoch is what survives a crash: fold says epoch 2.
    expect(openHost(root, "conv-1").host.state().epoch).toBe(2);
  });

  test("the log is never a weaker copy of the credential: 0600 log in a 0700 dir, secret redacted before durability", () => {
    const root = freshRoot();
    const { secret, paths } = createConversationRecord(root, "conv-1");

    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.logPath).mode & 0o777).toBe(0o600);

    const h = openHost(root, "conv-1");
    h.host.handleFrame(encodeFrame(attachFrame(secret)));
    const log = readFileSync(paths.logPath, "utf8");
    expect(log.includes(secret)).toBe(false);
    expect(log.includes("redacted")).toBe(true);

    // Fold re-injects the real secret: replay works, and a later attach
    // under the folded state still authenticates.
    const reopened = openHost(root, "conv-1", { now: 20_000 });
    expect(reopened.host.state().epoch).toBe(1);
    const re = reopened.host.handleFrame(encodeFrame(attachFrame(secret)));
    expect(re.verdict).toBe("accepted");
  });

  test("crash repair is byte-accurate under non-ASCII content, and a corrupt newline-terminated line is corruption - never silently discarded", () => {
    const root = freshRoot();
    const { secret, paths } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");
    h.host.handleFrame(encodeFrame(attachFrame(secret)));
    h.now = 2_000;
    h.host.handleFrame(
      encodeFrame(
        event({
          n: 1,
          event: { kind: "message", text: "emoji \u00e9\u00e8 \ud83d\ude00 payload" },
        }),
      ),
    );
    const live = h.host.state();
    const before = readFileSync(paths.logPath);

    // Torn tail after multibyte content: repair must not eat good entries.
    appendFileSync(paths.logPath, '{"v":1,"at":9,"src":"credit","tok');
    const repaired = openHost(root, "conv-1");
    expect(repaired.host.state()).toEqual(live);
    expect(readFileSync(paths.logPath).equals(before)).toBe(true);

    // A corrupt line WITH a newline is not a torn tail: typed corruption.
    appendFileSync(paths.logPath, "NOT-JSON\n");
    expect(() => openHost(root, "conv-1")).toThrow(StoreError);
  });

  test("an envelope-valid entry whose src this build does not know is carried, not applied (RFC-04 P1): the record opens, nothing is contributed, and its bytes count as good", () => {
    const root = freshRoot();
    const { secret, paths } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");
    h.host.handleFrame(encodeFrame(attachFrame(secret)));
    h.host.grantCredit(5);
    const before = h.host.state();
    const transcriptBefore = h.host.transcript();

    // Hand-composed line: no writer produces an unknown src yet. The
    // delivery cursor of RFC-04 will be exactly such an entry, and this
    // test is the prerequisite that keeps it from bricking the record.
    appendFileSync(paths.logPath, '{"v":1,"at":9,"src":"cursor","offset":42}\n');

    // The record opens, and the unknown entry contributed nothing.
    const reopened = openHost(root, "conv-1");
    expect(reopened.host.state()).toEqual(before);
    expect(reopened.host.transcript()).toEqual(transcriptBefore);
    const recovery = reopened.records[0];
    expect(recovery?.verdict).toBe("recovered");
    if (recovery?.verdict === "recovered") expect(recovery.entries).toBe(2);

    // Byte accounting is unchanged: the unknown line's bytes are good
    // (the fold did not treat them as a torn tail), through the lock-free
    // reader too.
    const raw = readFileSync(paths.logPath);
    expect(viewConversation(recordDir(root, "conv-1")).goodBytes).toBe(raw.length);

    // Later entries still fold past it, and a subsequent append lands
    // after it rather than over it.
    reopened.now = 3_000;
    reopened.host.grantCredit(1);
    const after = viewConversation(recordDir(root, "conv-1"));
    expect(after.state.credits).toBe(6);
    expect(after.goodBytes).toBe(readFileSync(paths.logPath).length);
    expect(readFileSync(paths.logPath, "utf8").includes('"src":"cursor"')).toBe(true);
  });

  test("envelope corruption is still refused whatever the src: a bad version or a missing timestamp is corruption, not an unknown entry (RFC-04 P1 keeps the envelope)", () => {
    const root = freshRoot();
    const { secret, paths } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");
    h.host.handleFrame(encodeFrame(attachFrame(secret)));

    // Bad version.
    appendFileSync(paths.logPath, '{"v":2,"at":9,"src":"cursor","offset":42}\n');
    expect(() => openHost(root, "conv-1")).toThrow(StoreError);
    expect(() => openHost(root, "conv-1")).toThrow(/malformed log entry/);

    // Missing timestamp, on a second clean record: the first file is
    // already refused for its own reason.
    const root2 = freshRoot();
    const made2 = createConversationRecord(root2, "conv-1");
    const h2 = openHost(root2, "conv-1");
    h2.host.handleFrame(encodeFrame(attachFrame(made2.secret)));
    appendFileSync(made2.paths.logPath, '{"v":1,"src":"cursor","offset":42}\n');
    expect(() => openHost(root2, "conv-1")).toThrow(StoreError);
    expect(() => openHost(root2, "conv-1")).toThrow(/malformed log entry/);
  });

  test("identity lives in meta, not the path: a moved record still opens and folds under its own conversationId", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");
    h.host.handleFrame(encodeFrame(attachFrame(secret)));

    renameSync(join(root, "conv-1"), join(root, "moved-elsewhere"));
    const moved = openHost(root, "moved-elsewhere");
    expect(moved.host.state().conversationId).toBe("conv-1");
    expect(moved.host.state().epoch).toBe(1);
  });

  test("record hygiene: path-escaping ids refused, provisioning whitespace in the secret file tolerated, recovery visible at the boundary", () => {
    const root = freshRoot();
    expect(() => createConversationRecord(root, "../evil")).toThrow(StoreError);
    expect(() => createConversationRecord(root, "a/b")).toThrow(StoreError);
    expect(() => createConversationRecord(root, "")).toThrow(StoreError);

    const { secret, paths } = createConversationRecord(root, "conv-1");
    writeFileSync(paths.secretPath, `${secret}\n`, { mode: 0o600 });
    const h = openHost(root, "conv-1");
    expect(h.host.handleFrame(encodeFrame(attachFrame(secret))).verdict).toBe("accepted");

    // One canonical recovery line per open.
    const reopened = openHost(root, "conv-1");
    const recovery = reopened.records[0];
    expect(recovery?.verdict).toBe("recovered");
    if (recovery?.verdict === "recovered") {
      expect(recovery.entries).toBe(1);
      expect(recovery.discardedBytes).toBe(0);
      expect(recovery.epoch).toBe(1);
    }
  });

  test("a refused-but-alive frame renews the lease in host memory - the retrying writer is not fenced out by the store layer", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1");
    h.host.handleFrame(encodeFrame(attachFrame(secret)));
    h.now = 2_000;
    h.host.handleFrame(encodeFrame(event({ n: 1 })));

    // Renewal due; the frame is a gap (refused) but the writer is alive.
    h.now = 12_000;
    const refused = h.host.handleFrame(encodeFrame(event({ n: 5 })));
    expect(refused.verdict).toBe("refused");
    expect(h.host.state().attachment?.lease.expires).toBe(12_000 + 15_000);
  });
});

describe("RFC-04 R2: only the presence-lock holder acts on effects", () => {
  test("a non-holder writes, produces the effects, and acts on none of them", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    // The running host: attaches while holding the lease, and its
    // attach-ok IS dispatched - a holder behaves exactly as before.
    const holder = openHost(root, "conv-1", { lease: true });
    holder.host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    expect(holder.effects.map((e) => e.type)).toEqual(["send"]);

    // `lucid send` in another process: folds the same record, sees the
    // live lease, so its reduce PRODUCES the input send - and acts on
    // none of it. The write is durable; the effect is left in the log
    // for the holder to find.
    const sender = openHost(root, "conv-1", { lease: false });
    const written = sender.host.enqueueInput({
      id: "in-1",
      text: "from a non-holder",
      mode: "queue",
    });
    expect(written.verdict).toBe("accepted");
    expect(written.effects).toHaveLength(1);
    expect(written.effects[0]).toMatchObject({
      type: "send",
      frame: { kind: "input", id: "in-1" },
    });
    expect(sender.effects).toHaveLength(0);
    expect(viewConversation(join(root, "conv-1")).transcript.inputs.map((i) => i.id)).toEqual([
      "in-1",
    ]);
  });

  test("a holder that loses the lease stops acting mid-life - the gate reads the handle live, not once at construction", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1", { lease: true });
    h.host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    expect(h.effects).toHaveLength(1); // attach-ok dispatched as a holder

    // Presence released or stolen: writes continue, effects are still
    // produced on the result, and none are acted on.
    h.lease = false;
    const after = h.host.enqueueInput({ id: "in-2", text: "lost the lease", mode: "queue" });
    expect(after.verdict).toBe("accepted");
    expect(after.effects).toHaveLength(1);
    expect(h.effects).toHaveLength(1);

    // Re-acquired: dispatch resumes, exactly as before.
    h.lease = true;
    const resumed = h.host.enqueueInput({ id: "in-3", text: "holder again", mode: "queue" });
    expect(resumed.verdict).toBe("accepted");
    expect(h.effects).toHaveLength(2);
    expect(h.effects[1]).toMatchObject({ type: "send", frame: { kind: "input", id: "in-3" } });
  });

  test("a malformed frame's refused reply is exempt - a local answer, not conversation work; a reducer refusal is gated", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const h = openHost(root, "conv-1", { lease: false });

    // A line that never decodes never reached `transact`: the sender is
    // owed its answer whichever process happens to read the wire.
    const torn = h.host.handleFrame('{"kind":"attach","secret":"x"');
    expect(torn).toMatchObject({ verdict: "refused", wire: true });
    expect(h.effects).toEqual([{ type: "send", frame: { kind: "refused", issue: "not-json" } }]);

    // A decoder-clean frame the reducer refuses (wrong secret) IS
    // conversation work: it rode `transact`, so a non-holder leaves the
    // effect unacted - the effect is still on the returned result.
    const wrong = h.host.handleFrame(encodeFrame(attachFrame("wrong")));
    expect(wrong.verdict).toBe("refused");
    expect("issue" in wrong && wrong.issue).toBe("auth-failed");
    expect("effects" in wrong ? wrong.effects : []).toEqual([
      { type: "send", frame: { kind: "refused", issue: "auth-failed" } },
    ]);
    expect(h.effects).toHaveLength(1); // still only the decode refusal
  });

  test("the attach replay stays on the reduce result - reading effects there needs no lease", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const writer = openHost(root, "conv-1", { lease: false });

    // Nothing attached, so the input queues armed for replay - the write
    // a non-holder leaves behind.
    writer.host.enqueueInput({ id: "in-1", text: "held while nothing ran", mode: "queue" });
    expect(writer.effects).toHaveLength(0);

    // The next attacher reads the replay straight off the attach's
    // ReduceResult (`createSequencer`'s path), not through the effect
    // sink - so R2's gate on the sink costs it nothing. Proven here with
    // the attacher itself a non-holder: the result still carries the
    // replay frames.
    const attachResult = writer.host.handleFrame(
      encodeFrame(attachFrame(secret, { profile: "headless-session" })),
    );
    expect(attachResult.verdict).toBe("accepted");
    if (!("effects" in attachResult))
      throw new Error("expected a reduce result, not a wire refusal");
    const replayed = attachResult.effects.flatMap((e) =>
      e.type === "send" && e.frame.kind === "input" ? [e.frame.id] : [],
    );
    expect(replayed).toEqual(["in-1"]);
    expect(writer.effects).toHaveLength(0);
  });
});
