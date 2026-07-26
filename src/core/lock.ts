import { closeSync, openSync } from "node:fs";

/**
 * Cross-process exclusive append lock (D-049). The RFC mandates an exclusive
 * advisory `flock` on `log.ndjson` so a mis-judged liveness can never
 * interleave two writers into a torn committed line.
 *
 * Primary: real `flock(2)` via FFI on an open fd - it auto-releases when the
 * fd closes or the process dies, which a plain lockfile cannot guarantee.
 * Fallback: an `O_EXCL` lockfile mutex with stale-lock stealing, used if FFI is
 * unavailable for any reason.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type FlockFn = (fd: number, op: number) => number;

const loadFlock = (): FlockFn | undefined => {
  try {
    // Lazy import so non-FFI environments (and typecheck) don't hard-depend on it.
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
        // try next candidate
      }
    }
  } catch {
    // bun:ffi not available
  }
  return undefined;
};

const flock: FlockFn | undefined = loadFlock();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRY_MS = 3;
/**
 * How long an append waits for the artifact's lock.
 *
 * Generous on purpose. Appends serialize per artifact, and an agent rewriting a
 * large artifact holds the lock for seconds at a time - at 5s a human message
 * sent during that burst was REFUSED, which is the wrong trade: waiting is
 * invisible, losing the message is not.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run `fn` while holding an exclusive lock on `lockTargetPath`. The lock is on
 * a sibling `<path>.lock` file so the data file's own fd lifecycle is
 * independent of the lock.
 */
export const withAppendLock = async <T>(
  lockTargetPath: string,
  fn: () => Promise<T> | T,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> => {
  const lockPath = `${lockTargetPath}.lock`;

  if (flock) {
    // openSync with 'a' creates the lockfile if absent and yields a real fd.
    const fd = openSync(lockPath, "a");
    const deadline = Date.now() + timeoutMs;
    try {
      // Non-blocking acquire loop keeps the event loop free under contention.
      for (;;) {
        const r = flock(fd, LOCK_EX | LOCK_NB);
        if (r === 0) break;
        if (Date.now() > deadline) {
          throw new Error(`timed out acquiring append lock on ${lockTargetPath}`);
        }
        await sleep(RETRY_MS);
      }
      return await fn();
    } finally {
      try {
        flock(fd, LOCK_UN);
      } catch {
        // best-effort unlock; closing the fd releases it regardless
      }
      closeSync(fd);
    }
  }

  return withLockfileFallback(lockPath, fn, timeoutMs);
};

const STALE_MS = 10_000;

const withLockfileFallback = async <T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  timeoutMs: number,
): Promise<T> => {
  const fs = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Steal a stale lock (owner likely crashed without releasing).
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock vanished between stat attempts; retry acquire
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring append lock (lockfile) on ${lockPath}`);
      }
      await sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
};
