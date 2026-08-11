/**
 * Owns the durable append-only conversation log and is the single seq authority.
 * It mints the per-conversation secret at record creation, hosts the protocol
 * reducer, and performs the actual enforcement of the reducer's verdicts. It
 * also writes the structured boundary logging that other layers consume, and it
 * is the only component permitted to advance the seq or to persist frames.
 */
export {
  createConversationRecord,
  type HostDeps,
  type HostRecord,
  openConversation,
  pathsForDir,
  type RecordPaths,
  type RecoveryRecord,
  recordPaths,
  StoreError,
  type Transcript,
  type TranscriptEvent,
  type WireRecord,
} from "./store.js";
