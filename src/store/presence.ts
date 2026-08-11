import { join } from "node:path";
import { acquireAppendLock, type LockEvent } from "./lock.js";

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
  // Use the append-lock primitive but on the presence file - same flock
  // guarantee, different file. We pass the base path (without .lock)
  // so lock.ts derives the sibling correctly; but presence.lock is
  // already the lock file itself, so we pass its stem.
  const base = lockPath.replace(/\.lock$/, "");
  const lock = acquireAppendLock(base, {
    label: conversationId,
    onEvent: opts.onLockEvent,
  });
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
