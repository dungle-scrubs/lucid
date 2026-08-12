/**
 * Owns the durable append-only conversation log and is the single seq authority.
 * It mints the per-conversation secret at record creation, hosts the protocol
 * reducer, and performs the actual enforcement of the reducer's verdicts. It
 * also writes the structured boundary logging that other layers consume, and it
 * is the only component permitted to advance the seq or to persist frames.
 */

// Safe lock surface re-exported through the store barrel so callers do not
// deep-import the lock module. `acquireWith` stays `@internal` (deep-import
// only) because passing a fake flock would defeat the flock-only invariant
// (D-008).
export {
  type AcquireOpts,
  type AppendLock,
  acquireAppendLock,
  heldLocks,
  type LockBackend,
  LockError,
  type LockEvent,
  lockBackend,
} from "./lock.js";
export type { AppendEvent } from "./store.js";
export {
  createConversationRecord,
  type HostDeps,
  type HostRecord,
  type HostSnapshot,
  openConversation,
  pathsForDir,
  type RecordPaths,
  type RecoveryRecord,
  recordPaths,
  StoreError,
  type Transcript,
  type TranscriptEvent,
  type ViewSnapshot,
  viewConversation,
  viewSnapshot,
  type WireRecord,
} from "./store.js";
