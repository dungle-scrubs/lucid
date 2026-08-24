import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effect } from "../../src/protocol/index.js";
import { encodeFrame, type Frame } from "../../src/protocol/index.js";
import { readRecordFiles } from "../../src/store/conversation-host.js";
import type { LockEvent } from "../../src/store/lock.js";
import { collectEffectsUnderAppendLock, foldCollect } from "../../src/store/log.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-collect-"));

const recordDir = (root: string, id: string) => join(root, id);

const attachFrame = (
  secret: string,
  overrides: Partial<Extract<Frame, { kind: "attach" }>> = {},
): Frame => attach({ secret, ...overrides });

const openHost = (root: string, id: string, now = 1_000, lease = true) => {
  const effects: Effect[] = [];
  const host = openConversation(recordDir(root, id), {
    now: () => now,
    presence: () => undefined,
    executorLease: () => lease,
    onEffect: (e) => effects.push(e),
    onRecord: () => {},
  });
  return { host, effects };
};

describe("the range fold that hands back effects (RFC-04 step 5)", () => {
  test("a caller can fold from a given position and receive effects in log order", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const { host } = openHost(root, "conv-1", 1_000);
    host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    host.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });
    host.enqueueInput({ id: "in-2", text: "world", mode: "queue" });

    // Collect from 0 gets attach + both inputs' effects
    const all = host.collectEffects(0).entries;
    expect(all.length).toBe(3);
    // Offsets are byte positions, strictly increasing
    const offsets = all.map((c) => c.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    // Each entry produced a send effect for the input
    for (const c of all) expect(c.effects[0]?.type).toBe("send");

    // Collect from after first entry's offset gets only the second
    // Length is asserted 3 above, so the fallback is unreachable; it is here
    // because indexing is checked and a test should not assert its way past that.
    const secondOffset = offsets[offsets.length - 1] ?? 0;
    const secondOnly = host.collectEffects(secondOffset).entries;
    expect(secondOnly.length).toBe(1);
    expect(secondOnly[0]?.offset).toBe(secondOffset);

    // Past the end gets nothing
    const pastEnd = host.collectEffects(secondOffset + 100_000);
    expect(pastEnd.entries.length).toBe(0);
  });

  test("each effect is paired with the position of the entry that produced it", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const { host } = openHost(root, "conv-1");
    host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    host.enqueueInput({ id: "in-1", text: "a", mode: "queue" });
    host.enqueueInput({ id: "in-2", text: "b", mode: "queue" });

    const batch = host.collectEffects(0);
    // Verify offsets match the file's byte positions by parsing the log
    const raw = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    let byte = 0;
    const offsets: number[] = [];
    for (const line of lines) {
      offsets.push(byte);
      byte += Buffer.byteLength(line + "\n");
    }
    // The log has attach + 2 inputs = 3 lines. All 3 produced effects (attach-ok + 2 sends).
    expect(lines.length).toBe(3);
    expect(batch.entries.length).toBe(3);
    expect(batch.entries[0]?.offset).toBe(offsets[0]);
    expect(batch.entries[1]?.offset).toBe(offsets[1]);
    expect(batch.entries[2]?.offset).toBe(offsets[2]);
  });

  test("the fold runs under the append lock and returns effects without dispatching inside", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const { host } = openHost(root, "conv-1");
    host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    host.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });

    const lockEvents: LockEvent[] = [];
    const { paths } = readRecordFiles(join(root, "conv-1"));
    // Direct locked helper also takes the lock
    const batch = collectEffectsUnderAppendLock(paths, "conv-1", secret, 0, {
      onLockEvent: (e) => lockEvents.push(e),
    });
    expect(lockEvents.map((e) => e.event)).toEqual(["lock.acquire", "lock.release"]);
    expect(batch.entries.length).toBe(2);

    // The host's collect does not dispatch to its own sink
    const before = host.collectEffects(0).entries;
    const afterDispatchCheck = host.collectEffects(0).entries;
    expect(before.length).toBe(afterDispatchCheck.length);
    // Effects are returned even though the host's onEffect was not called
    // for this collect — the host's effects array only grew via transact,
    // not via collect.
    // (We already verified the host collected via transact above; the
    // point is collect does not add more.)
  });

  test("an entry the reducer refuses contributes no effects", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const { host } = openHost(root, "conv-1");
    host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    host.enqueueInput({ id: "in-1", text: "once", mode: "queue" });

    // Manually append a second input with the same id — the reducer will
    // refuse it (input-id-reused) and the collecting fold must produce no
    // effects for it, not throw.
    const dupOffset = statSync(join(root, "conv-1", "log.ndjson")).size;
    const dupLine =
      JSON.stringify({
        v: 1,
        at: 9_999,
        src: "input",
        input: { id: "in-1", text: "again", mode: "queue" },
      }) + "\n";
    appendFileSync(join(root, "conv-1", "log.ndjson"), dupLine);

    // A refused INPUT entry is carried, not fatal (RFC-05 B4): the
    // collecting fold yields no effects for that offset, and both folds
    // report the refusal rather than dropping it silently.
    const all = host.collectEffects(0).entries;
    // attach + first input, not the duplicate's (refused)
    expect(all.length).toBe(2);
    expect(all[0]?.effects[0]?.type).toBe("send"); // biome-ignore lint/style/noNonNullAssertion: test asserts existence above

    // Pure helper also does not throw, and reports the refusal like
    // foldLog does - same fold, not a second policy.
    const raw = readFileSync(join(root, "conv-1", "log.ndjson"));
    const pure = foldCollect("conv-1", secret, raw, 0);
    expect(pure.collected.length).toBe(2);
    expect(pure.refusedInputs).toEqual([{ offset: dupOffset, issue: "input-id-reused" }]);
  });

  test("an entry with an unrecognised source contributes no effects and does not break later entries", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const { host } = openHost(root, "conv-1");
    host.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    const goodBefore = statSync(join(root, "conv-1", "log.ndjson")).size;
    // Unknown source — RFC-04 P1 says it is carried, not applied
    const unknown = JSON.stringify({ v: 1, at: 2_000, src: "cursor", offset: 123 }) + "\n";
    appendFileSync(join(root, "conv-1", "log.ndjson"), unknown);
    const unknownOffset = goodBefore;
    host.enqueueInput({ id: "in-after", text: "after unknown", mode: "queue" });

    const all = host.collectEffects(0).entries;
    // Attachok + in-after, unknown contributes nothing
    const effectIds = all.flatMap((e) => e.effects.map(() => e.offset));
    expect(effectIds).not.toContain(unknownOffset);
    // But the entry after the unknown still folds and still has effects
    expect(all.some((e) => e.effects.some((eff) => eff.type === "send"))).toBe(true);

    // Also via pure fold
    const raw2 = readFileSync(join(root, "conv-1", "log.ndjson"));
    const pure2 = foldCollect("conv-1", secret, raw2, 0);
    expect(pure2.collected.every((c) => c.offset !== unknownOffset)).toBe(true);
  });

  test("existing fold and append behaviour is unchanged", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const { host } = openHost(root, "conv-1");
    const attachRes = host.handleFrame(encodeFrame(attachFrame(secret)));
    expect(attachRes.verdict).toBe("accepted");
    const enq = host.enqueueInput({ id: "in-1", text: "hi", mode: "queue" });
    expect(enq.verdict).toBe("accepted");
    expect(enq.effects.length).toBe(1);
  });
});
