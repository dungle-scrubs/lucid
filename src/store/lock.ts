/**
 * The append lock — thin wrapper over the deep `Flock` primitive.
 *
 * `Flock` (`src/store/flock.ts`) owns the `flock(2)` discipline;
 * this module is the append-specific seam that the store and tests
 * import. It re-exports the safe surface (`acquireAppendLock`,
 * `lockBackend`, `LockError`, `heldLocks`) and keeps `acquireWith`
 * deep-import only (`@internal`) so a fake flock cannot defeat the
 * flock-only invariant (D-008). What it is NOT: not a pid-file, not a
 * stale-steal, not a fallback.
 */

export {
  type AcquireOpts,
  type AppendLock,
  acquireAppendLock,
  acquireWith,
  backendFor,
  Flock,
  heldLocks,
  type LockBackend,
  LockError,
  type LockEvent,
  lockBackend,
} from "./flock.js";
