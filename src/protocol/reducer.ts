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

import { classOfEventKind, DROPPABLE_QUEUE_MAX } from "./events.js";
import type {
  AttachProfile,
  DetachReason,
  Frame,
  FrameKind,
  InputMode,
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

/** Disposition state machine: outstanding -> applied | queued; a rejected
 * disposition returns the input to outstanding (counted), never drops it.
 * "Accepted input" per PLAN 4.3 = durable applied|queued disposition. */
export type InputStatus = "outstanding" | "queued" | "applied";

export interface QueuedInput {
  /** Idempotent id: replay and boundary redelivery reuse it, so the source
   * applies an input at most once however many times it is delivered. */
  readonly id: string;
  readonly seq: number;
  readonly text: string;
  readonly mode: InputMode;
  readonly turnId?: string;
  readonly status: InputStatus;
  /** Times a reject disposition returned this input to the queue. */
  readonly rejections: number;
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
  /** The outbound input queue: every input ever enqueued, with its
   * disposition state. Applied entries stay for idempotency accounting. */
  readonly inputs: readonly QueuedInput[];
  /** Flow credits granted but not yet consumed by droppable events.
   * Bounded by DROPPABLE_QUEUE_MAX, which is what bounds the number of
   * droppable frames in flight between render drains. */
  readonly credits: number;
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
  /** Input-delivery observability: which input, and the queue depth gauge
   * (inputs not yet applied) after the transition. */
  readonly inputId?: string;
  readonly queueDepth?: number;
  /** Credit observability: tokens granted/consumed by this transition and
   * the outstanding balance after it. */
  readonly tokens?: number;
  readonly credits?: number;
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
  inputs: [],
  credits: 0,
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
): Pick<TransitionRecord, "frameEpoch" | "n" | "turnId" | "profile" | "reason" | "inputId"> => ({
  ...("epoch" in frame && frame.epoch !== stateEpoch ? { frameEpoch: frame.epoch } : {}),
  ...("n" in frame ? { n: frame.n } : {}),
  ...("turnId" in frame && frame.turnId !== undefined ? { turnId: frame.turnId } : {}),
  ...(frame.kind === "attach" ? { profile: frame.profile } : {}),
  ...(frame.kind === "detach" ? { reason: frame.reason } : {}),
  ...(frame.kind === "input" ? { inputId: frame.id } : {}),
  ...(frame.kind === "disposition" ? { inputId: frame.inputId } : {}),
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
  extra?: Pick<TransitionRecord, "queueDepth" | "credits">,
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
    ...extra,
  },
});

const inputFrame = (input: QueuedInput): Frame => ({
  kind: "input",
  seq: input.seq,
  id: input.id,
  text: input.text,
  mode: input.mode,
  ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
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
  const replayFrom = frame.resumeFrom ?? 0;
  // Replay: every non-applied input past the source's durable watermark,
  // in seq order - the idempotent id makes redelivery safe.
  const replayed = state.inputs.filter((i) => i.status !== "applied" && i.seq > replayFrom);
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
          // source durably APPLIED, so replay delivers seq > replayFrom
          // and never re-delivers the applied frame.
          replayFrom,
          version: PROTOCOL_VERSION,
        },
      },
      ...replayed.map((i) => ({ type: "send", frame: inputFrame(i) }) as const),
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
      // Droppable events are credit-gated (PLAN 4.5). A starved refusal
      // leaves lastN untouched: the source coalesces and resends the same
      // n once credit arrives. Lossless is never gated.
      const droppable = classOfEventKind(frame.event.kind) === "droppable";
      if (droppable && state.credits === 0)
        return refusedButAlive(state, attachment, frame, "no-credit", now);
      // A turn boundary is the redelivery point for inputs a disposition
      // rejected: same idempotent id, so the source applies at most once.
      const redelivered = sameTurn
        ? []
        : state.inputs.filter((i) => i.status === "outstanding" && i.rejections > 0);
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
          credits: droppable ? state.credits - 1 : state.credits,
        },
        frame,
        now,
        [
          { type: "send", frame: { kind: "event-ack", epoch: frame.epoch, n: frame.n } },
          ...redelivered.map((i) => ({ type: "send", frame: inputFrame(i) }) as const),
        ],
        droppable ? { credits: state.credits - 1 } : undefined,
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
    case "disposition": {
      const target = state.inputs.find((i) => i.id === frame.inputId);
      if (target === undefined)
        return refusedButAlive(state, attachment, frame, "unknown-input", now);
      // applied is terminal: late or redelivered dispositions are
      // idempotent no-ops, which is what makes redelivery safe.
      const next: QueuedInput =
        target.status === "applied"
          ? target
          : frame.outcome === "rejected"
            ? { ...target, status: "outstanding", rejections: target.rejections + 1 }
            : { ...target, status: frame.outcome };
      const inputs =
        next === target ? state.inputs : state.inputs.map((i) => (i.id === next.id ? next : i));
      return accepted(
        { ...state, seq, inputs, attachment: renewAttachment(attachment, now) },
        frame,
        now,
        NO_EFFECTS,
        { queueDepth: queueDepth(inputs) },
      );
    }
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

/** Inputs not yet durably applied - the queue depth gauge the host logs. */
const queueDepth = (inputs: readonly QueuedInput[]): number =>
  inputs.filter((i) => i.status !== "applied").length;

/** Host transition: lucid queues an input for delivery to the source. The
 * minted seq and idempotent id travel on the wire, so replay and boundary
 * redelivery can re-deliver without double-application. */
export const enqueueInput = (
  state: ChannelState,
  input: {
    readonly id: string;
    readonly text: string;
    readonly mode: InputMode;
    readonly turnId?: string;
  },
  now: number,
): ReduceResult => {
  const seq = state.seq + 1;
  const frame: Frame = {
    kind: "input",
    seq,
    id: input.id,
    text: input.text,
    mode: input.mode,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
  if (state.inputs.some((existing) => existing.id === input.id))
    return refusal(state, frame, "input-id-reused", now);
  const queued: QueuedInput = {
    id: input.id,
    seq,
    text: input.text,
    mode: input.mode,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    status: "outstanding",
    rejections: 0,
  };
  const inputs = [...state.inputs, queued];
  return {
    verdict: "accepted",
    state: { ...state, seq, inputs },
    effects: state.attachment === null ? NO_EFFECTS : [{ type: "send", frame }],
    record: {
      verdict: "accepted",
      kind: "input",
      conversationId: state.conversationId,
      epoch: state.epoch,
      seq,
      inputId: input.id,
      queueDepth: queueDepth(inputs),
      now,
    },
  };
};

/** Host transition: grant flow credits for the droppable class only
 * (PLAN 4.5). The grant is clamped so outstanding credits never exceed
 * DROPPABLE_QUEUE_MAX - that clamp IS the bounded queue: at most MAX
 * droppable frames can be accepted between render drains. */
export const grantCredit = (state: ChannelState, tokens: number, now: number): ReduceResult => {
  const frame: Frame = { kind: "credit", epoch: state.epoch, tokens };
  if (state.attachment === null) return refusal(state, frame, "not-attached", now);
  const granted = Math.min(tokens, DROPPABLE_QUEUE_MAX - state.credits);
  const credits = state.credits + granted;
  return {
    verdict: "accepted",
    state: granted === 0 ? state : { ...state, credits },
    effects:
      granted === 0
        ? NO_EFFECTS
        : [{ type: "send", frame: { kind: "credit", epoch: state.epoch, tokens: granted } }],
    record: {
      verdict: "accepted",
      kind: "credit",
      conversationId: state.conversationId,
      epoch: state.epoch,
      tokens: granted,
      credits,
      now,
    },
  };
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
