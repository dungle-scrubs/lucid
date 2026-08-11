/**
 * The pure chat-session reducer: (state, frame, now) -> accepted | refusal.
 * Owns epoch fencing (a takeover increments the epoch; stale-epoch frames
 * are refused, which is what makes the lease enforceable - D-002), lease
 * accounting against the INJECTED clock (zero wall-clock reads), lucid's
 * seq authority (every accepted frame is assigned the next seq), and the
 * per-epoch n gap/dupe check on source events.
 *
 * Every transition - accepted or refused - returns a structured record the
 * host logs verbatim; a refusal names its issue, never applies the frame,
 * and its `refused` send effect is the only operator-visible auth signal.
 * NOT responsible for durability, transport, or enforcement: the store
 * hosts the reducer and enforces its verdicts.
 */

import type {
  AttachProfile,
  DetachReason,
  Frame,
  FrameKind,
  Lease,
  RefusalIssue,
} from "./frames.js";

export type { RefusalIssue } from "./frames.js";

export const PROTOCOL_VERSION = 1;

/** Lease constants live in one place; the reducer only ever compares them
 * against the injected `now`. These realize PLAN.md's `renewEvery` /
 * `expires`; the liveness detector constants (HEARTBEAT_MS,
 * ATTACH_GRACE_MS - M4.4) must be added HERE, not in a second module. */
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
  /** Last lucid-minted seq - the durable log position. Every accepted frame
   * consumes one (PLAN.md: "every frame lucid accepts is assigned a seq"),
   * so the space is sparse from a source's view: bookkeeping frames
   * (heartbeat/ack/detach) hold seqs that are never replayable, and the
   * host filters deliverable kinds when honoring replayFrom. */
  readonly seq: number;
  /** Current fencing token; 0 = never attached. Survives detach. */
  readonly epoch: number;
  readonly attachment: Attachment | null;
  /** The turnId of the last accepted event under the current writer. The
   * protocol cannot see turn completion (the event payload is opaque), so
   * this may name an already-finished turn; the host owns turn lifecycle
   * and treats an abort-turn for a finished turn as a no-op. */
  readonly turn: { readonly turnId: string } | null;
  /** Highest lucid seq the CURRENT writer claims durably applied: rebased
   * from resumeFrom at attach, then monotonic within the attachment
   * (ack.covers). */
  readonly acked: number;
  /** Every turnId ever accepted, keyed for O(1) first-sight validation
   * (PLAN 4.3: unique within the conversation). Grows per TURN, not per
   * frame. Checked with Object.hasOwn - `in` would leak prototype keys
   * like "constructor" into the refusal path. */
  readonly seenTurns: { readonly [turnId: string]: true };
}

export type Effect =
  | { readonly type: "send"; readonly frame: Frame }
  | { readonly type: "abort-turn"; readonly turnId: string };

/** For comparison refusals: what the frame claimed vs what lucid holds. */
export interface RefusalDetail {
  readonly claimed: number;
  readonly head: number;
}

/** The wide event for one transition - the host logs it verbatim. */
export interface TransitionRecord {
  readonly verdict: "accepted" | "refused";
  readonly kind: FrameKind;
  readonly conversationId: string;
  /** State epoch after the transition (unchanged on refusal). */
  readonly epoch: number;
  readonly now: number;
  /** Minted on acceptance only. */
  readonly seq?: number;
  /** The source counter, when the frame carried one. */
  readonly n?: number;
  /** The epoch the frame carried, when it differs from the state epoch. */
  readonly frameEpoch?: number;
  readonly turnId?: string;
  readonly profile?: AttachProfile;
  readonly reason?: DetachReason;
  readonly issue?: RefusalIssue;
  readonly detail?: RefusalDetail;
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
      /** The frame is NEVER applied. State differs from the input only when
       * a post-fence refusal renews the lease (liveness accounting). */
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
  seenTurns: {},
});

/** The ONE place the lease-expiry comparison lives. The host consults this
 * when deciding channel liveness instead of re-deriving the comparison. */
export const isLive = (state: ChannelState, now: number): boolean =>
  state.attachment !== null && now < state.attachment.lease.expires;

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

/** Record fields derived from the frame itself - ONE derivation for both
 * the accepted and refused constructors, so the two records cannot drift. */
const frameFields = (
  stateEpoch: number,
  frame: Frame,
): Pick<TransitionRecord, "frameEpoch" | "n" | "turnId" | "profile" | "reason"> => ({
  ...("epoch" in frame && frame.epoch !== stateEpoch ? { frameEpoch: frame.epoch } : {}),
  ...("n" in frame ? { n: frame.n } : {}),
  ...("turnId" in frame && frame.turnId !== undefined ? { turnId: frame.turnId } : {}),
  ...(frame.kind === "attach" ? { profile: frame.profile } : {}),
  ...(frame.kind === "detach" ? { reason: frame.reason } : {}),
});

/** Every refusal is built here: the frame is never applied (`state` is the
 * caller's state - input identity except post-fence lease renewal), a
 * `refused` send (the only operator-visible auth signal), and a record
 * naming the issue. */
const refusal = (
  state: ChannelState,
  frame: Frame,
  issue: RefusalIssue,
  now: number,
  detail?: RefusalDetail,
): ReduceResult => ({
  verdict: "refused",
  issue,
  state,
  effects: [{ type: "send", frame: { kind: "refused", issue } }],
  record: {
    verdict: "refused",
    kind: frame.kind,
    conversationId: state.conversationId,
    epoch: state.epoch,
    issue,
    now,
    ...(detail === undefined ? {} : { detail }),
    ...frameFields(state.epoch, frame),
  },
});

/** Every acceptance is built here: the next state already carries the
 * minted seq, and the record mirrors it for the host's log. */
const accepted = (
  next: ChannelState,
  frame: Frame,
  now: number,
  effects: readonly Effect[],
): ReduceResult => ({
  verdict: "accepted",
  state: next,
  effects,
  record: {
    verdict: "accepted",
    kind: frame.kind,
    conversationId: next.conversationId,
    epoch: next.epoch,
    seq: next.seq,
    now,
    ...frameFields(next.epoch, frame),
  },
});

/** PLAN.md: "a lease is renewed by any frame plus explicit lease grants."
 * Re-minting is gated at renewEvery granularity so per-token frames do not
 * churn lease identity: `expires` only ever moves forward, and a writer
 * streaming frames always holds >= TTL - renewEvery of headroom. */
const renewLease = (lease: Lease, now: number): Lease =>
  now + LEASE_TTL_MS - lease.expires >= LEASE_RENEW_EVERY_MS
    ? { expires: now + LEASE_TTL_MS, renewEvery: LEASE_RENEW_EVERY_MS }
    : lease;

const renewAttachment = (attachment: Attachment, now: number): Attachment => {
  const lease = renewLease(attachment.lease, now);
  return lease === attachment.lease ? attachment : { ...attachment, lease };
};

/** A refusal from the CURRENT writer still proves the channel alive: the
 * frame is never applied, but the lease renews. Only post-fence refusals
 * reach this - a stale or unauthenticated writer must never hold the
 * lease open. */
const refusedButAlive = (
  state: ChannelState,
  attachment: Attachment,
  frame: Frame,
  issue: RefusalIssue,
  now: number,
  detail?: RefusalDetail,
): ReduceResult => {
  const renewed = renewAttachment(attachment, now);
  const next = renewed === attachment ? state : { ...state, attachment: renewed };
  return refusal(next, frame, issue, now, detail);
};

const reduceAttach = (
  state: ChannelState,
  frame: Extract<Frame, { kind: "attach" }>,
  now: number,
): ReduceResult => {
  if (frame.conversationId !== state.conversationId)
    return refusal(state, frame, "wrong-conversation", now);
  if (frame.secret !== state.secret) return refusal(state, frame, "auth-failed", now);
  if (frame.version !== PROTOCOL_VERSION)
    return refusal(state, frame, "version-unsupported", now, {
      claimed: frame.version,
      head: PROTOCOL_VERSION,
    });
  if (isLive(state, now)) return refusal(state, frame, "lease-held", now);
  if (frame.resumeFrom !== undefined && frame.resumeFrom > state.seq)
    return refusal(state, frame, "resume-ahead-of-log", now, {
      claimed: frame.resumeFrom,
      head: state.seq,
    });

  const epoch = state.epoch + 1;
  const lease: Lease = { expires: now + LEASE_TTL_MS, renewEvery: LEASE_RENEW_EVERY_MS };
  // A stale-lease takeover is the one handoff allowed mid-turn; whatever
  // turn the old writer may still be running is aborted (the host treats
  // an abort for an already-finished turn as a no-op).
  const aborted = state.turn;
  return accepted(
    {
      ...state,
      seq: state.seq + 1,
      epoch,
      attachment: { profile: frame.profile, lastN: 0, lease },
      turn: null,
      // The watermark speaks for the CURRENT writer only: rebased from what
      // this attach claims durably applied, never inherited from the last.
      acked: frame.resumeFrom ?? 0,
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
          // The exclusive replay watermark: resumeFrom is the last seq the
          // source durably APPLIED, so replay (M4.3) delivers seq >
          // replayFrom and never re-delivers the applied frame.
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
 * renewed by any frame from the current writer. */
const reducePostAttach = (
  state: ChannelState,
  frame: PostAttachFrame,
  now: number,
): ReduceResult => {
  const attachment = state.attachment;
  if (attachment === null) return refusal(state, frame, "not-attached", now);
  if (frame.epoch < state.epoch) return refusal(state, frame, "stale-epoch", now);
  // An epoch ahead of state is a forged token, a split-brain host, or a
  // state-restore bug - named separately so the operator looks forward.
  if (frame.epoch > state.epoch) return refusal(state, frame, "future-epoch", now);

  const seq = state.seq + 1;
  switch (frame.kind) {
    case "event": {
      if (frame.n <= attachment.lastN)
        return refusedButAlive(state, attachment, frame, "dupe-n", now);
      if (frame.n > attachment.lastN + 1)
        return refusedButAlive(state, attachment, frame, "gap-n", now);
      // turnId validated on first sight (PLAN 4.3): a retired id can never
      // come back - which is also what makes a takeover's abort final.
      const sameTurn = state.turn !== null && state.turn.turnId === frame.turnId;
      if (!sameTurn && Object.hasOwn(state.seenTurns, frame.turnId))
        return refusedButAlive(state, attachment, frame, "turn-id-reused", now);
      return accepted(
        {
          ...state,
          seq,
          attachment: {
            profile: attachment.profile,
            lastN: frame.n,
            lease: renewLease(attachment.lease, now),
          },
          turn: sameTurn ? state.turn : { turnId: frame.turnId },
          seenTurns: sameTurn
            ? state.seenTurns
            : { ...state.seenTurns, [frame.turnId]: true as const },
        },
        frame,
        now,
        [{ type: "send", frame: { kind: "event-ack", epoch: frame.epoch, n: frame.n } }],
      );
    }
    case "ack": {
      if (frame.covers > state.seq)
        return refusedButAlive(state, attachment, frame, "covers-ahead-of-log", now, {
          claimed: frame.covers,
          head: state.seq,
        });
      return accepted(
        {
          ...state,
          seq,
          acked: Math.max(state.acked, frame.covers),
          attachment: renewAttachment(attachment, now),
        },
        frame,
        now,
        NO_EFFECTS,
      );
    }
    case "disposition":
      return accepted(
        { ...state, seq, attachment: renewAttachment(attachment, now) },
        frame,
        now,
        NO_EFFECTS,
      );
    case "heartbeat": {
      const renewed = renewAttachment(attachment, now);
      return accepted({ ...state, seq, attachment: renewed }, frame, now, [
        {
          type: "send",
          frame: { kind: "lease", epoch: state.epoch, expires: renewed.lease.expires },
        },
      ]);
    }
    case "detach":
      // The departing writer can never finish its turn - abort it now
      // rather than leaving a dangling turn no writer could ever end.
      return accepted(
        { ...state, seq, attachment: null, turn: null },
        frame,
        now,
        state.turn === null ? NO_EFFECTS : [{ type: "abort-turn", turnId: state.turn.turnId }],
      );
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
