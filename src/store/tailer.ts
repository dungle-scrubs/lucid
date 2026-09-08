/**
 * The record tailer — the shared watch-and-poll loop, plus the two reads
 * it keeps separate (RFC-04 R1, implementation step 4).
 *
 * Before, the loop that notices a record growing lived inline in
 * `src/cli/watch.ts` (fs.watch + a poll fallback + abort wiring), welded
 * to the viewer's paint step. RFC-04 needs the same loop inside a live
 * host — but a host *acts* on what it reads, and the viewer's read path
 * is lock-free: `viewSnapshot` tolerates a torn trailing line without
 * repairing it, which a dispatching caller must never act on. Copying
 * the loop would fork the mechanism; sharing it verbatim would hand the
 * leader a reader's torn-tail tolerance. So the tailer is one module
 * with two reads, not one loop with two users of the same read:
 *
 * - `peek()` — lock-free. Same fold seam as `viewSnapshot`. Tolerates a
 *   torn trailing line (stops at `goodBytes`) and never repairs, never
 *   locks. For deciding whether the log grew, and for the viewer's
 *   paint step, which only reads. Not for anything a caller acts on.
 * - `read()` — takes the append lock, folds, repairs a torn trailing
 *   fragment (`foldUnderAppendLock` — `append`'s own catch-up
 *   discipline), releases, and returns the revalidated tail. This is
 *   the read a live host dispatches from.
 *
 * `followRecord` is the extracted watch-and-poll loop: it triggers once
 * immediately, then on every `fs.watch` event and every poll tick, and
 * resolves when the signal aborts. Polling always runs alongside the
 * watch — on filesystems where `fs.watch` is unreliable the poll alone
 * keeps the follower live. The 500ms cadence is deliberate (RFC-04:
 * same machine, single user — latency here is not worth engineering
 * for); do not tighten it.
 *
 * Deletion test: deleting this module would put the loop back inline in
 * the viewer and fork a second copy into the headless host.
 *
 * What it is NOT: it is not the viewer (no paint policy — `watch.ts`
 * owns that), not a dispatch path (a host still decides what to do with
 * `read()`'s result — the cursor and lease rules are RFC-04's, not the
 * tailer's), and not a lock owner outside the store (the locked read
 * goes through `foldUnderAppendLock`, the log's own seam).
 */

import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { ChannelState } from "../protocol/index.js";
import { readRecordFiles, type ViewSnapshot, viewSnapshot } from "./conversation-host.js";
import type { LockEvent } from "./flock.js";
import { foldUnderAppendLock, type Transcript } from "./log.js";

/** The poll fallback cadence, unchanged from `watch.ts` (D-004: network
 * FS is out of scope, but polling keeps the follower live even there). */
export const DEFAULT_POLL_MS = 500;

export interface TailerDeps {
  /** Injected clock for the peek's status derivation — defaults to
   * `Date.now`. Tests inject to assert lease-expiry transitions without
   * wall-clock flakiness. */
  readonly now?: () => number;
  /** Injected presence probe for the peek's status — defaults unknown.
   * The ps-level interactive fact, NOT the presence handle; a leader
   * must gate dispatch on its handle, never on this (RFC-04 M2). */
  readonly presence?: () => boolean | undefined;
  /** Append-lock observability for the locked read. */
  readonly onLockEvent?: (e: LockEvent) => void;
}

/** The durable facts a follower reads off the tail. No `status`: the
 * status projection is the viewer's (clock + ps-probe), and a leader
 * that gated anything on it would be gating on the wrong presence
 * fact. */
export interface Tail {
  readonly state: ChannelState;
  readonly transcript: Transcript;
  readonly goodBytes: number;
}

export interface RecordTailer {
  /** Lock-free peek. Returns the same snapshot the viewer paints from
   * (fold once, status from that same state + injected clock/presence).
   * Tolerates a torn trailing line WITHOUT repairing it — callers that
   * act on what they read must revalidate via `read()`, never act on a
   * peek (RFC-04 R1). */
  peek(): ViewSnapshot;
  /** Lock-taking read: folds the whole log under the append lock,
   * repairs a torn trailing fragment, and returns the revalidated tail.
   * The read a caller acts on. */
  read(): Tail;
}

export const createTailer = (dir: string, deps: TailerDeps = {}): RecordTailer => ({
  peek: () => viewSnapshot(dir, { now: deps.now, presence: deps.presence }),
  read: () => {
    // Loaded per call, not at construction: a follower may start before
    // the record exists (watch does), and the load must fail on the
    // call, not on the wiring.
    const { secret, conversationId, paths } = readRecordFiles(dir);
    return foldUnderAppendLock(paths, conversationId, secret, { onLockEvent: deps.onLockEvent });
  },
});

export interface FollowOpts {
  /** The record directory (`<root>/<conversationId>`). */
  readonly dir: string;
  /** Poll cadence in ms — defaults to `DEFAULT_POLL_MS` (500). */
  readonly pollMs?: number;
  /** Abort signal: closes the watcher, clears the poll, resolves. */
  readonly signal?: AbortSignal;
  /** Reads policy for the tailer handed to `onTrigger`. */
  readonly tailerDeps?: TailerDeps;
  /** Called once immediately, then on every fs.watch event and every
   * poll tick. Receives the tailer; pick `peek` or `read` by whether
   * the caller acts on the result. */
  readonly onTrigger: (tailer: RecordTailer) => void;
}

/** Follow a record as it grows: one immediate trigger, then fs.watch
 * events plus an unconditional poll fallback, until `signal` aborts.
 * Holds no lock between triggers — the loop is the shared mechanism;
 * what a trigger does with the tailer is the caller's policy. Resolves
 * when aborted (or never, long-lived, when no signal is given). */
export const followRecord = async (opts: FollowOpts): Promise<void> => {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const tailer = createTailer(opts.dir, opts.tailerDeps ?? {});
  // A trigger that throws must not take the follower down with it. The
  // first one runs before the watcher and the poll exist, so an unguarded
  // throw there escaped `followRecord` entirely: no watcher, no interval,
  // and a conversation deaf for the rest of the process with nothing in
  // the log to say why. Found by a live send that was recorded and never
  // answered, intermittently, depending on what the first trigger hit.
  const trigger = (): void => {
    try {
      opts.onTrigger(tailer);
    } catch {}
  };

  trigger();

  if (opts.signal?.aborted) return;

  return new Promise<void>((resolve) => {
    const abort = (): void => {
      watcher?.close();
      clearInterval(poll);
      resolve();
    };
    if (opts.signal) opts.signal.addEventListener("abort", abort, { once: true });

    let watcher: ReturnType<typeof fsWatch> | undefined;
    try {
      watcher = fsWatch(join(opts.dir, "log.ndjson"), trigger);
      watcher.on("error", () => {});
    } catch {
      // Record dir may not exist yet; poll will pick it up.
    }
    const poll = setInterval(trigger, pollMs);
    // Also poll on an interval as a fallback for filesystems where
    // fs.watch is unreliable (network FS is out of scope, D-004, but
    // polling keeps the follower live even there).
  });
};
