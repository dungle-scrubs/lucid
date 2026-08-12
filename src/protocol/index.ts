/**
 * Owns the pure chat-session protocol: frame codecs validated at the wire
 * boundary (frames.ts) and the reducer that folds frames into channel state
 * with epoch fencing, lease accounting, and lucid's seq authority
 * (reducer.ts). It performs no I/O of any kind, so it stays fully testable
 * and deterministic. It is NOT responsible for durability or enforcement;
 * the store hosts it and enforces its verdicts.
 */

export {
  classOfEventKind,
  coalesceDroppable,
  DROPPABLE_KINDS,
  DROPPABLE_QUEUE_MAX,
  type EventClass,
  EventKind,
  type HarnessEventKind,
  isKnownEventKind,
  LOSSLESS_KINDS,
  type PendingDroppable,
  supersedeTurn,
} from "./events.js";
export {
  type AttachProfile,
  type ControlAction,
  DECODE_ISSUES,
  type DecodeIssue,
  type DecodeVerdict,
  type DetachReason,
  type Disposition,
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  type Frame,
  type FrameKind,
  type InputMode,
  type Lease,
  type ProtocolIssue,
  parseFrame,
  REFUSAL_ISSUES,
  type RefusalIssue,
} from "./frames.js";
export {
  AttachmentLedger,
  CreditLedger,
  clampedGrant,
  clearRedeliver,
  InputLedger,
  isStarved,
  queueDepth,
  redeliverable,
  renewAttachment,
  renewLease,
} from "./ledgers/index.js";
export {
  ATTACH_GRACE_MS,
  type ChannelStatus,
  channelStatus,
  HEARTBEAT_MS,
} from "./liveness.js";
export {
  type Attachment,
  type ChannelState,
  type Effect,
  enqueueInput,
  grantCredit,
  type InputStatus,
  initialChannelState,
  isLive,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
  type Presence,
  type QueuedInput,
  type ReduceContext,
  type ReduceResult,
  type RefusalDetail,
  reduce,
  type TransitionRecord,
} from "./reducer.js";
