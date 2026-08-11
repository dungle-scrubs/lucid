/**
 * The pure chat-session reducer: (state, frame, now) -> accepted | refusal.
 * Owns epoch fencing (a takeover increments the epoch; stale-epoch frames
 * are refused, which is what makes the lease enforceable - D-002), lease
 * accounting against the INJECTED clock (zero wall-clock reads), lucid's
 * seq authority (every accepted frame is assigned the next seq), and the
 * per-epoch n gap/dupe check on source events.
 *
 * Every transition - accepted or refused - returns a structured record the
 * host logs verbatim; a refusal names its issue, leaves state untouched
 * (never half-applied), and its `refused` send effect is the only
 * operator-visible auth signal. NOT responsible for durability, transport,
 * or enforcement: the store hosts the reducer and enforces its verdicts.
 */

import type { AttachProfile, Frame, FrameKind, Lease } from "./frames.js";

export const PROTOCOL_VERSION = 1;

/** Lease constants live in one place; the reducer only ever compares them
 * against the injected `now`. */
export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_EVERY_MS = 5_000;

export interface Attachment {
  readonly profile: AttachProfile;
  /** Last accepted per-epoch source counter; next event must carry lastN+1. */
  readonly lastN: number;
  readonly lease: Lease;
}

export interface ChannelState {
  readonly conversationId: string;
  /** Minted by the host at record creation (D-004); checked only at attach. */
  readonly secret: string;
  /** Last lucid-minted seq - the durable log position. */
  readonly seq: number;
  /** Current fencing token; 0 = never attached. Survives detach. */
  readonly epoch: number;
  readonly attachment: Attachment | null;
  /** The in-flight turn, tracked from accepted events. */
  readonly turn: { readonly turnId: string } | null;
  /** Highest lucid seq the source claims durably applied (ack.covers). */
  readonly acked: number;
}

export type RefusalIssue =
  | "auth-failed"
  | "wrong-conversation"
  | "version-unsupported"
  | "resume-ahead-of-log"
  | "lease-held"
  | "not-attached"
  | "stale-epoch"
  | "gap-n"
  | "dupe-n"
  | "covers-ahead-of-log"
  | "wrong-direction";

export type Effect =
  | { readonly type: "send"; readonly frame: Frame }
  | { readonly type: "abort-turn"; readonly turnId: string };

/** The wide event for one transition - the host logs it verbatim. */
export interface TransitionRecord {
  readonly verdict: "accepted" | "refused";
  readonly kind: FrameKind;
  /** State epoch after the transition (unchanged on refusal). */
  readonly epoch: number;
  readonly now: number;
  /** Minted on acceptance only. */
  readonly seq?: number;
  /** The source counter, when the frame carried one. */
  readonly n?: number;
  /** The epoch the frame carried, when it differs from the state epoch. */
  readonly frameEpoch?: number;
  readonly issue?: RefusalIssue;
}

export type ReduceResult =
  | {
      readonly verdict: "accepted";
      readonly state: ChannelState;
      readonly effects: readonly Effect[];
      readonly record: TransitionRecord;
    }
  | {
      readonly verdict: "refused";
      readonly issue: RefusalIssue;
      /** Always the input state, by identity - refusals never half-apply. */
      readonly state: ChannelState;
      readonly effects: readonly Effect[];
      readonly record: TransitionRecord;
    };

export const initialChannelState = (init: {
  readonly conversationId: string;
  readonly secret: string;
}): ChannelState => ({
  conversationId: init.conversationId,
  secret: init.secret,
  seq: 0,
  epoch: 0,
  attachment: null,
  turn: null,
  acked: 0,
});

/** Every refusal is built here: input state BY IDENTITY (never half-applied),
 * a `refused` send (the only operator-visible auth signal), and a record
 * naming the issue. */
const refusal = (
  state: ChannelState,
  frame: Frame,
  issue: RefusalIssue,
  now: number,
): ReduceResult => ({
  verdict: "refused",
  issue,
  state,
  effects: [{ type: "send", frame: { kind: "refused", issue } }],
  record: {
    verdict: "refused",
    kind: frame.kind,
    epoch: state.epoch,
    issue,
    now,
    ...("epoch" in frame && frame.epoch !== state.epoch ? { frameEpoch: frame.epoch } : {}),
    ...("n" in frame ? { n: frame.n } : {}),
  },
});

const renewedLease = (now: number): Lease => ({
  expires: now + LEASE_TTL_MS,
  renewEvery: LEASE_RENEW_EVERY_MS,
});

/** Every acceptance is built here: the next state already carries the
 * minted seq, and the record mirrors it for the host's log. */
const accepted = (
  next: ChannelState,
  frame: Frame,
  now: number,
  effects: readonly Effect[],
  n?: number,
): ReduceResult => ({
  verdict: "accepted",
  state: next,
  effects,
  record: {
    verdict: "accepted",
    kind: frame.kind,
    epoch: next.epoch,
    seq: next.seq,
    now,
    ...(n === undefined ? {} : { n }),
  },
});

const reduceAttach = (
  state: ChannelState,
  frame: Extract<Frame, { kind: "attach" }>,
  now: number,
): ReduceResult => {
  if (frame.conversationId !== state.conversationId)
    return refusal(state, frame, "wrong-conversation", now);
  if (frame.secret !== state.secret) return refusal(state, frame, "auth-failed", now);
  if (frame.version !== PROTOCOL_VERSION) return refusal(state, frame, "version-unsupported", now);
  if (state.attachment !== null && now < state.attachment.lease.expires)
    return refusal(state, frame, "lease-held", now);
  if (frame.resumeFrom !== undefined && frame.resumeFrom > state.seq)
    return refusal(state, frame, "resume-ahead-of-log", now);

  const epoch = state.epoch + 1;
  const lease = renewedLease(now);
  // A stale-lease takeover is the one handoff allowed mid-turn, and it
  // aborts the in-flight turn rather than letting two writers share it.
  const aborted = state.turn;
  return accepted(
    {
      ...state,
      seq: state.seq + 1,
      epoch,
      attachment: { profile: frame.profile, lastN: 0, lease },
      turn: null,
    },
    frame,
    now,
    [
      ...(aborted === null ? [] : [{ type: "abort-turn", turnId: aborted.turnId } as const]),
      {
        type: "send",
        frame: {
          kind: "attach-ok",
          epoch,
          lease,
          replayFrom: frame.resumeFrom ?? 0,
          version: PROTOCOL_VERSION,
        },
      },
    ],
  );
};

type PostAttachFrame = Extract<
  Frame,
  { kind: "event" | "ack" | "disposition" | "heartbeat" | "detach" }
>;

/** The shared spine of every post-attach source frame: a live attachment,
 * the CURRENT epoch (the fencing check - D-002), a minted seq, and a lease
 * renewed by any accepted frame. */
const reducePostAttach = (
  state: ChannelState,
  frame: PostAttachFrame,
  now: number,
): ReduceResult => {
  const attachment = state.attachment;
  if (attachment === null) return refusal(state, frame, "not-attached", now);
  if (frame.epoch !== state.epoch) return refusal(state, frame, "stale-epoch", now);

  const seq = state.seq + 1;
  const renewed: Attachment = { ...attachment, lease: renewedLease(now) };
  switch (frame.kind) {
    case "event": {
      if (frame.n <= attachment.lastN) return refusal(state, frame, "dupe-n", now);
      if (frame.n > attachment.lastN + 1) return refusal(state, frame, "gap-n", now);
      return accepted(
        {
          ...state,
          seq,
          attachment: { ...renewed, lastN: frame.n },
          turn: { turnId: frame.turnId },
        },
        frame,
        now,
        [{ type: "send", frame: { kind: "event-ack", epoch: frame.epoch, n: frame.n } }],
        frame.n,
      );
    }
    case "ack": {
      if (frame.covers > state.seq) return refusal(state, frame, "covers-ahead-of-log", now);
      return accepted({ ...state, seq, acked: frame.covers, attachment: renewed }, frame, now, []);
    }
    case "disposition":
      return accepted({ ...state, seq, attachment: renewed }, frame, now, []);
    case "heartbeat":
      return accepted({ ...state, seq, attachment: renewed }, frame, now, [
        {
          type: "send",
          frame: { kind: "lease", epoch: state.epoch, expires: renewed.lease.expires },
        },
      ]);
    case "detach":
      return accepted({ ...state, seq, attachment: null }, frame, now, []);
  }
};

export const reduce = (state: ChannelState, frame: Frame, now: number): ReduceResult => {
  switch (frame.kind) {
    case "attach":
      return reduceAttach(state, frame, now);
    case "event":
    case "ack":
    case "disposition":
    case "heartbeat":
    case "detach":
      return reducePostAttach(state, frame, now);
    // lucid->source kinds arriving AT lucid are forgeries or bugs, never
    // applied: an impersonator cannot end, redirect, or grant anything by
    // replaying the server's own vocabulary at it.
    case "attach-ok":
    case "refused":
    case "event-ack":
    case "input":
    case "control":
    case "lease":
    case "credit":
      return refusal(state, frame, "wrong-direction", now);
  }
};
