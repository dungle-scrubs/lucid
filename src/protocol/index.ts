/**
 * Owns the pure chat-session protocol: frame codecs validated at the wire
 * boundary (frames.ts) and the reducer that folds frames into channel state
 * with epoch fencing, lease accounting, and lucid's seq authority
 * (reducer.ts). It performs no I/O of any kind, so it stays fully testable
 * and deterministic. It is NOT responsible for durability or enforcement;
 * the store hosts it and enforces its verdicts.
 */
export {
  type AttachProfile,
  type ControlAction,
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
  parseFrame,
} from "./frames.js";
export {
  type Attachment,
  type ChannelState,
  type Effect,
  initialChannelState,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
  type ReduceResult,
  type RefusalIssue,
  reduce,
  type TransitionRecord,
} from "./reducer.js";
