/**
 * The append lock: a single-writer critical section over a conversation's
 * `log.ndjson`, taken as a real `flock(2)` on a sibling `<log>.lock`.
 *
 * `flock` is the ONE mandated backend (D-008). The kernel releases it when
 * the holding fd closes or the holding process dies - that death-release is
 * the whole reason it exists, and it is what makes a mis-judged liveness
 * unable to interleave two writers into a torn committed line.
 *
 * This module deliberately does NOT implement the fallbacks v1 carried and
 * this design rejects: no O_EXCL lockfile, no pid-file, no stale-steal
 * unlink. Those cannot release on holder death and do not interoperate with
 * `flock`, so a mixed fleet could double-hold the "same" lock. When `flock`
 * is unavailable (no `bun:ffi`) there is no safe write lock at all: the
 * backend reports `"readonly"` and `acquire` refuses, so a caller may still
 * fold read-only (tolerating a torn trailing line) but can never take an
 * unsafe write lock. NOT responsible for the fold/reduce transaction itself
 * (that is the store's append transaction, which calls this) - only for the
 * OS lock.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

type FlockFn = (fd: number, op: number) => number;

// BSD/POSIX flock operations.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const RETRY_MS = 3;
/** Generous on purpose: appends serialize per conversation, and an agent
 * emitting a large burst holds the lock for a beat. Waiting is invisible;
 * refusing a queued human message is not. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** A private, never-written, never-notified word to park on. Shared across
 * `sleepSync` calls: `Atomics.wait` always sees index 0 === 0 and parks for
 * the full `ms`, so one module-global buffer is correct and allocation-free. */
const PARK = new Int32Array(new SharedArrayBuffer(4));

/** Sleep synchronously without busy-spinning, so `acquire` stays synchronous
 * (the whole store is sync) yet a bounded timeout still holds. `Atomics.wait`
 * parks the thread for up to `ms`. */
const sleepSync = (ms: number): void => {
  Atomics.wait(PARK, 0, 0, ms);
};

const loadFlock = (): FlockFn | undefined => {
  try {
    // Lazy require so non-FFI environments (and typecheck) don't hard-depend on it.
    const { dlopen, FFIType, suffix } = require("bun:ffi") as typeof import("bun:ffi");
    const candidates =
      process.platform === "darwin"
        ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]
        : [`libc.${suffix}`, "libc.so.6", "libc.so"];
    for (const lib of candidates) {
      try {
        const opened = dlopen(lib, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        const fn = opened.symbols.flock as unknown as FlockFn;
        if (typeof fn === "function") return fn;
      } catch {
        // try the next candidate library
      }
    }
  } catch {
    // bun:ffi unavailable in this runtime
  }
  return undefined;
};

const flock: FlockFn | undefined = loadFlock();

/** Which locking guarantee is actually in force. `"flock"` = real advisory
 * lock with death-release; `"readonly"` = no FFI, so no safe write lock and
 * only lock-free read-only folding is possible. */
export type LockBackend = "flock" | "readonly";

/** Pure backend selection, exported so both branches are unit-testable
 * without manipulating the runtime's FFI availability. */
export const backendFor = (fn: FlockFn | undefined): LockBackend => (fn ? "flock" : "readonly");

/** Inspectable state: the lock guarantee this process actually selected.
 * The choice is made once at import, silently, from whether `dlopen` found
 * libc - so anything asserting concurrent-append behaviour must be able to
 * read which guarantee it is relying on. */
export const lockBackend = (): LockBackend => backendFor(flock);

/** Typed error at the lock boundary (RFC E001 and the unavailable guard),
 * carrying which conversation's lock target failed so a caller can surface
 * it without string-parsing. */
export class LockError extends Error {
  override readonly name = "LockError";
  constructor(
    readonly code: "lock-timeout" | "lock-unavailable",
    readonly target: string,
    message: string,
  ) {
    super(message);
  }
}

/** A held lock. `release()` unlocks and closes the fd; the kernel would do
 * the same on process death, so a missed release is a leak, never a
 * deadlock across processes. */
export interface AppendLock {
  release(): void;
}

/** Structured boundary event, emitted always-on when an `onEvent` sink is
 * wired (the append transaction passes the conversationId as `label`). */
export type LockEvent =
  | { readonly event: "lock.acquire"; readonly target: string; readonly label?: string }
  | {
      readonly event: "lock.timeout";
      readonly target: string;
      readonly label?: string;
      readonly waitedMs: number;
    }
  | { readonly event: "lock.release"; readonly target: string; readonly label?: string };

export interface AcquireOpts {
  readonly timeoutMs?: number;
  /** Correlation id for the structured events (the conversationId). */
  readonly label?: string;
  readonly onEvent?: (event: LockEvent) => void;
}

/** The lock targets currently held by THIS process, for inspection. Keyed by
 * the caller's target path (not the sibling `.lock`), which is what a caller
 * reasons about. */
const held = new Set<string>();
export const heldLocks = (): readonly string[] => [...held];

/** Emit a structured lock event, isolating the caller's sink: an observability
 * callback must NEVER be able to throw into the lock lifecycle (a throw after
 * the flock is taken but before the handle returns would strand the lock held
 * with no way to release it). */
const emit = (opts: AcquireOpts | undefined, event: LockEvent): void => {
  try {
    opts?.onEvent?.(event);
  } catch {
    // an observability sink cannot be allowed to corrupt lock state
  }
};

/**
 * Injectable core so the unavailable branch is testable without removing FFI
 * from the runtime. `acquireAppendLock` binds `fn` to the resolved `flock`.
 * @internal - NOT part of the store's public surface (the barrel does not
 * re-export it): passing a fake `fn` would defeat the flock-only invariant,
 * so production callers use `acquireAppendLock`, which binds the real `flock`.
 */
export const acquireWith = (
  fn: FlockFn | undefined,
  lockTargetPath: string,
  opts?: AcquireOpts,
): AppendLock => {
  if (!fn) {
    // No FFI flock: there is no safe write lock. Refuse rather than fall back
    // to an O_EXCL lockfile that cannot release on death (D-008). We bail
    // before touching the filesystem, so no stray lockfile is left behind.
    throw new LockError(
      "lock-unavailable",
      lockTargetPath,
      `no flock backend available; refusing an unsafe write lock on ${lockTargetPath}`,
    );
  }
  // A non-finite or negative timeout would make `now >= deadline` never true
  // (NaN/Infinity) and hang forever - reject it as the programming error it is.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`acquireAppendLock timeoutMs must be a finite, non-negative number`);
  }
  const lockPath = `${lockTargetPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  // `a` creates the sibling lockfile if absent and yields a real fd.
  const lockFd = openSync(lockPath, "a");
  // Own the fd until a live handle is handed off; ANY throw before then closes
  // it in the finally, so no exception path (fn, sleep, timeout) leaks the fd.
  let handedOff = false;
  try {
    // Monotonic clock for the deadline - a wall-clock adjustment must not
    // extend or collapse the timeout.
    const start = performance.now();
    const deadline = start + timeoutMs;
    // Non-blocking acquire retried under a deadline: a held lock yields
    // EWOULDBLOCK (non-zero), so we sleep and retry until the target frees or
    // the deadline passes. Never force-steal - a persistent block means a live
    // holder (D-008). NOTE (bounded assumption, D-004 same-machine local disk):
    // on a valid fd on a local filesystem the only expected `flock` failure is
    // EWOULDBLOCK; a permanent error (e.g. ENOTSUP on an exotic FS) would be
    // reported as `lock-timeout` after the deadline rather than distinctly.
    // errno-precise classification is deferred until a non-local FS is in scope.
    for (;;) {
      if (fn(lockFd, LOCK_EX | LOCK_NB) === 0) break;
      if (performance.now() >= deadline) {
        emit(opts, {
          event: "lock.timeout",
          target: lockTargetPath,
          label: opts?.label,
          waitedMs: performance.now() - start,
        });
        throw new LockError(
          "lock-timeout",
          lockTargetPath,
          `timed out acquiring append lock on ${lockTargetPath}`,
        );
      }
      sleepSync(RETRY_MS);
    }
    held.add(lockTargetPath);
    // Build the handle BEFORE emitting, make release idempotent, and nest the
    // release finallys so neither a throwing sink, a double-release, nor a
    // throwing close can strand the lock or skip `held.delete`.
    let released = false;
    const lock: AppendLock = {
      release(): void {
        if (released) return;
        released = true;
        try {
          fn(lockFd, LOCK_UN);
        } finally {
          try {
            closeSync(lockFd);
          } finally {
            held.delete(lockTargetPath);
            emit(opts, { event: "lock.release", target: lockTargetPath, label: opts?.label });
          }
        }
      },
    };
    emit(opts, { event: "lock.acquire", target: lockTargetPath, label: opts?.label });
    handedOff = true;
    return lock;
  } finally {
    if (!handedOff) {
      // Acquire failed or threw before a handle was returned: never leak the
      // fd, and never leave a phantom `held` entry.
      try {
        closeSync(lockFd);
      } catch {
        // fd may already be closed; nothing else to do
      }
      held.delete(lockTargetPath);
    }
  }
};

/** Acquire the append lock for `lockTargetPath` (the protected file; the
 * lock is its sibling `<path>.lock`). Blocks up to `timeoutMs`, then raises
 * `LockError("lock-timeout")` (RFC E001) - it never force-steals, because a
 * persistent timeout under `flock` means a live holder. */
export const acquireAppendLock = (lockTargetPath: string, opts?: AcquireOpts): AppendLock =>
  acquireWith(flock, lockTargetPath, opts);
