import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockEvent } from "../../src/store/lock.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { createTailer, followRecord } from "../../src/store/tailer.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-tailer-"));

/** Bounded wait: the loop tests ride the poll fallback (pollMs = 10) so
 * they stay deterministic on any filesystem, including one where
 * fs.watch never fires - which is the condition under test. */
const until = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("tailer condition not met before deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A second writer: a real host appending through the real append lock,
 * the way `lucid send` grows a record a follower is watching. */
const writer = (root: string, conversationId: string, now = 1_000) =>
  openConversation(join(root, conversationId), {
    now: () => now,
    presence: () => undefined,
    onEffect: () => {},
    onRecord: () => {},
  });

const rig = (conversationId = "conv-1") => {
  const root = freshRoot();
  const { paths } = createConversationRecord(root, conversationId);
  const host = writer(root, conversationId);
  host.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });
  const lockEvents: LockEvent[] = [];
  const tailer = createTailer(join(root, conversationId), {
    now: () => 2_000,
    onLockEvent: (e) => lockEvents.push(e),
  });
  return { root, paths, host, tailer, lockEvents };
};

// Crash mid-append, composed inline (no recording shows a torn tail -
// the log repair tests do the same): a partial line with no newline.
const TORN = '{"v":1,"at":9,"src":"input","input":{"id":"tor';

describe("the shared record tailer (RFC-04 R1, step 4)", () => {
  test("peek is lock-free: it tolerates a torn tail without repairing it and without taking the append lock", () => {
    const { paths, tailer, lockEvents } = rig();
    const good = statSync(paths.logPath).size; // one complete input line
    appendFileSync(paths.logPath, TORN);

    const snap = tailer.peek();
    // The fold stops at goodBytes: the torn fragment is invisible...
    expect(snap.goodBytes).toBe(good);
    expect(snap.transcript.inputs.map((i) => i.id)).toEqual(["in-1"]);
    // ...but still on disk (a peek repairs nothing) and no lock was
    // touched — repairing is the locked read's job, not the peek's.
    expect(statSync(paths.logPath).size).toBe(good + TORN.length);
    expect(lockEvents).toEqual([]);
  });

  test("read takes the append lock, repairs the torn tail, and returns the revalidated fold", () => {
    const { paths, tailer, lockEvents } = rig();
    const good = statSync(paths.logPath).size;
    appendFileSync(paths.logPath, TORN);

    const tail = tailer.read();
    expect(lockEvents.map((e) => e.event)).toEqual(["lock.acquire", "lock.release"]);
    expect(tail.goodBytes).toBe(good);
    expect(tail.transcript.inputs.map((i) => i.id)).toEqual(["in-1"]);
    // The repair happened under the lock: the torn fragment is gone and
    // a later peek agrees with the file.
    expect(statSync(paths.logPath).size).toBe(good);
    expect(tailer.peek().goodBytes).toBe(good);
  });

  test("read revalidates under the lock: bytes another writer appended after the peek are included — the peek-decide-read flow a live host runs", () => {
    const { tailer, host } = rig();
    const peeked = tailer.peek().goodBytes;

    // Another process appends between the peek and the read. A host that
    // dispatched from the peek would miss this entry; the locked read
    // cannot.
    host.enqueueInput({ id: "in-2", text: "while peeking", mode: "queue" });

    const tail = tailer.read();
    expect(tail.goodBytes).toBeGreaterThan(peeked);
    expect(tail.transcript.inputs.map((i) => i.id)).toEqual(["in-1", "in-2"]);
  });

  test("followRecord triggers once immediately, follows growth from another writer, and stops on abort", async () => {
    const { root, host, paths } = rig();
    const controller = new AbortController();
    const seen: number[] = [];

    const following = followRecord({
      dir: join(root, "conv-1"),
      pollMs: 10,
      signal: controller.signal,
      onTrigger: (t) => seen.push(t.peek().goodBytes),
    });
    // The immediate trigger ran synchronously: one view exists before
    // any await, exactly like the viewer's first paint.
    expect(seen.length).toBe(1);

    host.enqueueInput({ id: "in-2", text: "second", mode: "queue" });
    const grown = statSync(paths.logPath).size;
    await until(() => seen.at(-1) === grown);

    controller.abort();
    await following;

    const stopped = seen.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.length).toBe(stopped); // watcher closed, poll cleared
  });

  test("followRecord keeps following on a filesystem where fs.watch cannot start — the poll fallback alone carries it", async () => {
    const root = freshRoot();
    // The record does not exist yet: fs.watch on the missing log throws
    // (swallowed), so only the poll ticks fire. This is the unreliable-
    // watch condition, forced deterministically.
    const controller = new AbortController();
    const triggers: (number | "error")[] = [];
    const following = followRecord({
      dir: join(root, "conv-late"),
      pollMs: 10,
      signal: controller.signal,
      onTrigger: (t) => {
        try {
          triggers.push(t.peek().goodBytes);
        } catch {
          triggers.push("error");
        }
      },
    });
    expect(triggers).toEqual(["error"]); // missing record surfaces per trigger, not fatally

    const { paths } = createConversationRecord(root, "conv-late");
    const host = writer(root, "conv-late");
    host.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });
    await until(() => triggers.at(-1) === statSync(paths.logPath).size);

    controller.abort();
    await following;
  });
});
