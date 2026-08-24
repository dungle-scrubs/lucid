import { join } from "node:path";
import { acquireAppendLock, Flock, LockError, type LockEvent } from "./flock.js";

export type PresenceEvent =
  | { readonly event: "presence.acquire"; readonly conversationId: string }
  | { readonly event: "presence.released"; readonly conversationId: string };

export interface PresenceHandle {
  /** Release the presence lock (idempotent). */
  readonly release: () => void;
  /** Whether the lock is still held by this handle. */
  readonly held: () => boolean;
}

/** Resolve the presence lock path for a record. */
export const presenceLockPath = (recordDir: string): string => join(recordDir, "presence.lock");

/** Also via RecordPaths (kept for uniformity with the append lock). */
export const presencePaths = (recordDir: string): { lockPath: string } => ({
  lockPath: presenceLockPath(recordDir),
});

/** Acquire the presence lock for `recordDir` and hold it for the
 * caller's lifetime. Emits `presence.acquire` on success and
 * `presence.released` on release. The lock is a real `flock`, so the
 * kernel releases it if the holder dies without an explicit release. */
export const acquirePresence = (
  recordDir: string,
  conversationId: string,
  opts: { onEvent?: (e: PresenceEvent) => void; onLockEvent?: (e: LockEvent) => void } = {},
): PresenceHandle => {
  const lockPath = presenceLockPath(recordDir);
  const flock = new Flock(lockPath, conversationId);
  const lock = flock.acquire({ onEvent: opts.onLockEvent });
  let held = true;
  opts.onEvent?.({ event: "presence.acquire", conversationId });

  const release = (): void => {
    if (!held) return;
    held = false;
    try {
      lock.release();
    } finally {
      opts.onEvent?.({ event: "presence.released", conversationId });
    }
  };

  return { release, held: () => held };
};

/** Bind a presence handle's lifetime to a child process's death via
 * pipe-EOF. The holder watches `child.pid` - when the child exits, the
 * presence lock is released. This is the pipe-EOF reap that makes a
 * false-alive impossible after death. */
export const bindToProcess = (
  handle: PresenceHandle,
  child: { readonly pid?: number; on: (event: "exit", cb: () => void) => void },
): void => {
  child.on("exit", () => handle.release());
};

/** Whether some process holds this record's presence lock — that is,
 * whether anything is driving the conversation right now.
 *
 * A reader cannot ask the log this. The lease in the durable state says
 * when the driver last wrote, not whether it is alive, and an idle driver
 * lets its lease lapse while sitting perfectly healthy. The lock is the
 * fact: it is a `flock`, so the kernel releases it when the holder dies,
 * and a holder that is alive still holds it however long it has been
 * quiet.
 *
 * Asked without blocking. A failed acquire means someone else holds it;
 * a successful one is released at once, so probing never keeps a driver
 * out — its own acquire retries. `undefined` when there is no flock
 * backend to ask, which is the same "unknown" every other presence
 * probe reports rather than guessing.
 */
export const presenceHeld = (recordDir: string): boolean | undefined => {
  const lockPath = presenceLockPath(recordDir);
  try {
    acquireAppendLock(lockPath, { timeoutMs: 0 }).release();
    return false;
  } catch (cause) {
    if (cause instanceof LockError && cause.code === "lock-timeout") return true;
    return undefined;
  }
};
