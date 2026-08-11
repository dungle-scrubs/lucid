/**
 * Flock — the deep primitive that owns `flock(2)`.
 *
 * One module owns the `bun:ffi` loading, the `LOCK_EX|LOCK_NB` retry
 * loop, the `held` tracking, and the structured `lock.*` events.
 * Both the append lock (`log.ndjson.lock`) and the presence lock
 * (`presence.lock`) are *instances* of this primitive, not copies.
 * Fixing the retry or the death-release guarantee fixes it for both.
 *
 * What it is NOT: it does not know the log, the fold, or the protocol;
 * it is a pure OS primitive.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

type FlockFn = (fd: number, op: number) => number;

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const RETRY_MS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const PARK = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(PARK, 0, 0, ms);
};

const loadFlock = (): FlockFn | undefined => {
  try {
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
      } catch {}
    }
  } catch {}
  return undefined;
};

const flock: FlockFn | undefined = loadFlock();

export type LockBackend = "flock" | "readonly";
export const backendFor = (fn: FlockFn | undefined): LockBackend => (fn ? "flock" : "readonly");
export const lockBackend = (): LockBackend => backendFor(flock);

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

export interface AppendLock {
  release(): void;
}

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
  readonly label?: string;
  readonly onEvent?: (event: LockEvent) => void;
}

const held = new Set<string>();
export const heldLocks = (): readonly string[] => [...held];

const emit = (opts: AcquireOpts | undefined, event: LockEvent): void => {
  try {
    opts?.onEvent?.(event);
  } catch {}
};

export const acquireWith = (
  fn: FlockFn | undefined,
  lockTargetPath: string,
  opts?: AcquireOpts,
): AppendLock => {
  if (!fn) {
    const normalized = lockTargetPath.endsWith(".lock")
      ? lockTargetPath.slice(0, -5)
      : lockTargetPath;
    throw new LockError(
      "lock-unavailable",
      normalized,
      `no flock backend available; refusing an unsafe write lock on ${normalized}`,
    );
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`acquireAppendLock timeoutMs must be a finite, non-negative number`);
  }
  const normalizedTarget = lockTargetPath.endsWith(".lock")
    ? lockTargetPath.slice(0, -5)
    : lockTargetPath;
  const lockPath = `${normalizedTarget}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const lockFd = openSync(lockPath, "a");
  let handedOff = false;
  try {
    const start = performance.now();
    const deadline = start + timeoutMs;
    for (;;) {
      if (fn(lockFd, LOCK_EX | LOCK_NB) === 0) break;
      if (performance.now() >= deadline) {
        emit(opts, {
          event: "lock.timeout",
          target: normalizedTarget,
          label: opts?.label,
          waitedMs: performance.now() - start,
        });
        throw new LockError(
          "lock-timeout",
          normalizedTarget,
          `timed out acquiring append lock on ${normalizedTarget}`,
        );
      }
      sleepSync(RETRY_MS);
    }
    held.add(normalizedTarget);
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
            held.delete(normalizedTarget);
            emit(opts, { event: "lock.release", target: normalizedTarget, label: opts?.label });
          }
        }
      },
    };
    emit(opts, { event: "lock.acquire", target: normalizedTarget, label: opts?.label });
    handedOff = true;
    return lock;
  } finally {
    if (!handedOff) {
      try {
        closeSync(lockFd);
      } catch {}
      held.delete(normalizedTarget);
    }
  }
};

export const acquireAppendLock = (lockTargetPath: string, opts?: AcquireOpts): AppendLock =>
  acquireWith(flock, lockTargetPath, opts);

/** The deep primitive as an object: `new Flock(lockPath)` gives you
 * `acquire` with the same guarantee, so append and presence are two
 * instances, not two implementations. */
export class Flock {
  constructor(
    private readonly lockTargetPath: string,
    private readonly label?: string,
  ) {}

  acquire(opts?: AcquireOpts): AppendLock {
    return acquireAppendLock(this.lockTargetPath, { ...opts, label: this.label ?? opts?.label });
  }

  get target(): string {
    return this.lockTargetPath.endsWith(".lock")
      ? this.lockTargetPath.slice(0, -5)
      : this.lockTargetPath;
  }
}
