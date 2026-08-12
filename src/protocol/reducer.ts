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
 *
 * Deepening (A): the reducer is a facade over three internal ledgers —
 * AttachmentLedger, InputLedger, and CreditLedger — each owning one
 * discipline hidden behind a small interface. The public surface stays
 * `reduce(state,frame,now,ctx)` plus `enqueueInput`/`grantCredit`/`isLive`,
 * so callers see one seam. Fixing a lease grace touches AttachmentLedger;
 * fixing disposition idempotency touches InputLedger; fixing credit clamp
 * touches CreditLedger — no longer the whole 8-branch switch. The ledgers
 * are internal (not exported from `protocol/index.ts`), but their
 * invariants become unit-testable without building a full ChannelState.
 * Deletion test: deleting a ledger would scatter its discipline back into
 * the switch and into liveness — two clocks again.
 */

import { classOfEventKind, DROPPABLE_QUEUE_MAX } from "./events.js";
import {
  type AttachProfile,
  type DetachReason,
  type Disposition,
  type Frame,
  type FrameKind,
  type InputMode,
  isWireId,
  isWireText,
  type Lease,
  type RefusalIssue,
} from "./frames.js";

export type { RefusalIssue } from "./frames.js";

export const PROTOCOL_VERSION = 1;

/** Lease constants live in one place; the reducer only ever compares them
 * against the injected `now`. These realize PLAN.md's `renewEvery` /
 * `expires`; the liveness detector constants (HEARTBEAT_MS,
 * ATTACH_GRACE_MS - M4.4) alias these — never a second clock. */
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
  /** Applied entries leave the queue (only the id survives, in
   * appliedInputs), so an entry here is never "applied". */
  readonly status: Exclude<InputStatus, "applied">;
  /** Times a reject disposition returned this input to the queue. */
  readonly rejections: number;
  /** Armed whenever a delivery is owed - a reject disposition, or an
   * enqueue with no live channel to send on - and consumed by the next
   * delivery (turn boundary or attach replay). Never a loop. */
  readonly redeliver: boolean;
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
  /** The outbound input queue: inputs awaiting or holding a non-applied
   * disposition, in seq order. Applied entries are trimmed to
   * appliedInputs so scans and persisted state stay bounded by the
   * genuinely open set. */
  readonly inputs: readonly QueuedInput[];
  /** Ids of inputs that reached the applied terminal, kept for idempotency
   * (duplicate dispositions no-op, ids can never be reused). Grows per
   * input; checked with Object.hasOwn like seenTurns. */
  readonly appliedInputs: { readonly [id: string]: true };
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
  /** Disposition observability: what the source reported, the input's
   * status AFTER the transition (a late outcome discarded against the
   * applied terminal shows inputStatus "applied"), and the rejection
   * count so a reject loop is visible. */
  readonly outcome?: Disposition;
  readonly inputStatus?: InputStatus;
  readonly rejections?: number;
  /** Credit observability: tokens GRANTED by this transition (consumption
   * shows up in credits alone) and the outstanding balance after it. */
  readonly tokens?: number;
  readonly credits?: number;
  /** Attach observability: what presence said when the verdict was made,
   * so a corroborated takeover and a blind one differ in the log. */
  readonly presence?: "alive" | "gone" | "unknown";
}

/** The normalizer's ps-level fact (M3.1), CONTRACTUALLY about the
 * INTERACTIVE process only (PLAN.md: presence answers "is an interactive
 * process attached now?"). Never feed it the liveness of lucid's own
 * headless child - that would fence a stalled runner against its own
 * recovery. */
export interface Presence {
  readonly processAlive: boolean;
}

/** Host-corroborated facts a transition may consult. ABSENT presence means
 * the host could not corroborate - presence never proves a channel, so
 * absence never blocks (epoch fencing is the defense - D-021). */
export interface ReduceContext {
  readonly presence?: Presence;
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
  appliedInputs: {},
  credits: 0,
});

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);
const NO_INPUTS: readonly QueuedInput[] = Object.freeze([]);

/** Record fields derived from the frame itself - ONE derivation for both
 * the accepted and refused constructors, so the two records cannot drift. */
const frameFields = (
  stateEpoch: number,
  frame: Frame,
): Pick<
  TransitionRecord,
  "frameEpoch" | "n" | "turnId" | "profile" | "reason" | "inputId" | "outcome"
> => {
  // Built imperatively into ONE object: this runs on every transition,
  // including every token event, so per-branch spread temporaries add up.
  const fields: {
    frameEpoch?: number;
    n?: number;
    turnId?: string;
    profile?: AttachProfile;
    reason?: DetachReason;
    inputId?: string;
    outcome?: Disposition;
  } = {};
  if ("epoch" in frame && frame.epoch !== stateEpoch) fields.frameEpoch = frame.epoch;
  if ("n" in frame) fields.n = frame.n;
  if ("turnId" in frame && frame.turnId !== undefined) fields.turnId = frame.turnId;
  if (frame.kind === "attach") fields.profile = frame.profile;
  if (frame.kind === "detach") fields.reason = frame.reason;
  if (frame.kind === "input") fields.inputId = frame.id;
  if (frame.kind === "disposition") {
    fields.inputId = frame.inputId;
    fields.outcome = frame.outcome;
  }
  return fields;
};

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
  extra?: Pick<TransitionRecord, "credits" | "queueDepth" | "presence">,
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
    ...extra,
  },
});

/** A refusal of a HOST transition (lucid-side programming error): recorded
 * for the operator, but no `refused` frame goes to the source - the wire
 * signal is reserved for frames the source actually sent. */
const hostRefusal = (
  state: ChannelState,
  frame: Frame,
  issue: RefusalIssue,
  now: number,
): ReduceResult => {
  const result = refusal(state, frame, issue, now);
  return { ...result, effects: NO_EFFECTS };
};

/** Every acceptance is built here: the next state already carries the
 * minted seq, and the record mirrors it for the host's log. */
const accepted = (
  next: ChannelState,
  frame: Frame,
  now: number,
  effects: readonly Effect[],
  extra?: Pick<
    TransitionRecord,
    "queueDepth" | "credits" | "inputStatus" | "rejections" | "presence"
  >,
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

// ─────────────────────────────────────────────────────────────
// AttachmentLedger — epoch fencing + lease accounting + attachment lifecycle
// Owns: isLive, renewLease, renewAttachment, refusedButAlive, and the
// attach-gate (auth, version, lease-held, presence-holds, resume-ahead).
// A lease fix touches only this ledger, not the input or credit code.
// ─────────────────────────────────────────────────────────────

const AttachmentLedger = {
  /** The ONE place the lease-expiry comparison lives. */
  isLive(state: ChannelState, now: number): boolean {
    return state.attachment !== null && now < state.attachment.lease.expires;
  },

  /** PLAN.md: "a lease is renewed by any frame plus explicit lease grants."
   * Re-minting is gated at renewEvery granularity so per-token frames do not
   * churn lease identity: `expires` only ever moves forward, and a writer
   * streaming frames always holds >= TTL - renewEvery of headroom. */
  renewLease(lease: Lease, now: number): Lease {
    return now + LEASE_TTL_MS - lease.expires >= LEASE_RENEW_EVERY_MS
      ? { expires: now + LEASE_TTL_MS, renewEvery: LEASE_RENEW_EVERY_MS }
      : lease;
  },

  renewAttachment(attachment: Attachment, now: number): Attachment {
    const lease = this.renewLease(attachment.lease, now);
    return lease === attachment.lease ? attachment : { ...attachment, lease };
  },

  /** A refusal from the CURRENT writer still proves the channel alive: the
   * frame is never applied, but the lease renews. Only post-fence refusals
   * reach this - a stale or unauthenticated writer must never hold the
   * lease open. */
  refusedButAlive(
    state: ChannelState,
    attachment: Attachment,
    frame: Frame,
    issue: RefusalIssue,
    now: number,
    detail?: RefusalDetail,
    extra?: Pick<TransitionRecord, "credits" | "queueDepth" | "presence">,
  ): ReduceResult {
    const renewed = this.renewAttachment(attachment, now);
    const next = renewed === attachment ? state : { ...state, attachment: renewed };
    return refusal(next, frame, issue, now, detail, extra);
  },
} as const;

/** Exported live check delegates to the ledger — one clock, one owner.
 * Hosts consult this, never arithmetic on HEARTBEAT_MS/ATTACH_GRACE_MS. */
export const isLive = (state: ChannelState, now: number): boolean =>
  AttachmentLedger.isLive(state, now);

// Keep thin top-level aliases so existing call sites keep their names
// but the logic lives in the ledger.
const renewLease = (lease: Lease, now: number): Lease => AttachmentLedger.renewLease(lease, now);
const renewAttachment = (attachment: Attachment, now: number): Attachment =>
  AttachmentLedger.renewAttachment(attachment, now);
const refusedButAlive = (
  state: ChannelState,
  attachment: Attachment,
  frame: Frame,
  issue: RefusalIssue,
  now: number,
  detail?: RefusalDetail,
  extra?: Pick<TransitionRecord, "credits" | "queueDepth" | "presence">,
): ReduceResult =>
  AttachmentLedger.refusedButAlive(state, attachment, frame, issue, now, detail, extra);

// ─────────────────────────────────────────────────────────────
// InputLedger — queue + disposition + redeliver
// Owns: queueDepth, input validation, enqueueInput, disposition
// state machine (outstanding→queued→applied, rejected→redeliver), and the
// turn-boundary redelivery consumed on next event. An input fix touches
// only this ledger.
// ─────────────────────────────────────────────────────────────

const InputLedger = {
  /** Inputs still AWAITING a disposition - the gauge the host pages on. */
  queueDepth(inputs: readonly QueuedInput[]): number {
    return inputs.filter((i) => i.status === "outstanding").length;
  },

  /** inputs that need redelivery at a turn boundary */
  redeliverable(inputs: readonly QueuedInput[], sameTurn: boolean): readonly QueuedInput[] {
    if (sameTurn) return NO_INPUTS;
    return inputs.filter((i) => i.redeliver);
  },

  /** Clear redeliver flags after they have been delivered */
  clearRedeliver(inputs: readonly QueuedInput[], hadRedeliver: boolean): readonly QueuedInput[] {
    if (!hadRedeliver) return inputs;
    const flagged = inputs.some((i) => i.redeliver);
    return flagged ? inputs.map((i) => (i.redeliver ? { ...i, redeliver: false } : i)) : inputs;
  },
} as const;

const queueDepth = (inputs: readonly QueuedInput[]): number => InputLedger.queueDepth(inputs);

// ─────────────────────────────────────────────────────────────
// CreditLedger — droppable flow control
// Owns: DROPPABLE_QUEUE_MAX clamp, grantCredit, and the no-credit gate
// on droppable events. A credit fix touches only this ledger, not fencing
// or disposition code.
// ─────────────────────────────────────────────────────────────

const CreditLedger = {
  /** Whether a droppable event is starved */
  isStarved(state: ChannelState): boolean {
    return state.credits <= 0;
  },

  /** Clamped grant — the bounded queue invariant */
  clampedGrant(state: ChannelState, tokens: number): number {
    return Math.min(tokens, DROPPABLE_QUEUE_MAX - state.credits);
  },
} as const;

const sendInputs = (inputs: readonly QueuedInput[]): readonly Effect[] =>
  inputs.map((i) => ({ type: "send", frame: inputFrame(i) }));

const reduceAttach = (
  state: ChannelState,
  frame: Extract<Frame, { kind: "attach" }>,
  now: number,
  ctx?: ReduceContext,
): ReduceResult => {
  const presence: "alive" | "gone" | "unknown" =
    ctx?.presence === undefined ? "unknown" : ctx.presence.processAlive ? "alive" : "gone";
  const withPresence = { presence } as const;
  if (frame.conversationId !== state.conversationId)
    return refusal(state, frame, "wrong-conversation", now);
  if (frame.secret !== state.secret) return refusal(state, frame, "auth-failed", now);
  if (frame.version !== PROTOCOL_VERSION)
    return refusal(state, frame, "version-unsupported", now, {
      claimed: frame.version,
      head: PROTOCOL_VERSION,
    });
  if (AttachmentLedger.isLive(state, now))
    return refusal(state, frame, "lease-held", now, undefined, withPresence);
  // interactive-unattached (dead channel, presence corroborates the human
  // process alive): a headless CONTENDER may not steal an interactively
  // held (or never-attached) conversation (PLAN 4.6). The gate never
  // fences a headless incumbent's own recovery, only a corroborated
  // presence blocks (unknown never does - D-021), and the human's own
  // adapter re-attaching is never gated.
  if (
    frame.profile !== "interactive" &&
    (state.attachment === null || state.attachment.profile === "interactive") &&
    ctx?.presence?.processAlive === true
  )
    return refusal(state, frame, "presence-holds", now, undefined, withPresence);
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
  // Replay EVERY input still awaiting an applied disposition, in seq
  // order. Lucid's own disposition state gates this - never the source's
  // resumeFrom claim, which speaks for the event log: trusting it here
  // would let one bogus attach silently drop the whole queue, and the
  // idempotent id already makes redelivery safe.
  const replayed = state.inputs;
  return accepted(
    {
      ...state,
      seq: state.seq + 1,
      epoch,
      attachment: { profile: frame.profile, lastN: 0, lease },
      turn: null,
      // The watermark and the credit balance speak for the CURRENT writer
      // only: acked rebased from what this attach claims durably applied,
      // credits zeroed (the new writer never received the old grants).
      acked: frame.resumeFrom ?? 0,
      credits: 0,
      // Replay IS this rejection's redelivery - disarm the flags.
      inputs: InputLedger.clearRedeliver(state.inputs, true),
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
      ...sendInputs(replayed),
    ],
    withPresence,
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
      if (droppable && CreditLedger.isStarved(state))
        return refusedButAlive(state, attachment, frame, "no-credit", now, undefined, {
          credits: state.credits,
        });
      // A turn boundary is the redelivery point for inputs a disposition
      // rejected (armed redeliver flag, consumed here): same idempotent
      // id, so the source applies at most once. Mid-turn events take the
      // ack-only path with zero scans or throwaway arrays.
      const ack = {
        type: "send",
        frame: { kind: "event-ack", epoch: frame.epoch, n: frame.n },
      } as const;
      const redelivered = InputLedger.redeliverable(state.inputs, sameTurn);
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
          inputs: InputLedger.clearRedeliver(state.inputs, redelivered.length > 0),
        },
        frame,
        now,
        redelivered.length === 0 ? [ack] : [ack, ...sendInputs(redelivered)],
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
      if (target === undefined) {
        // applied is terminal: a late or redelivered disposition against
        // it is an idempotent no-op (which is what makes redelivery
        // safe), and the record says so via inputStatus "applied".
        if (Object.hasOwn(state.appliedInputs, frame.inputId))
          return accepted(
            { ...state, seq, attachment: renewAttachment(attachment, now) },
            frame,
            now,
            NO_EFFECTS,
            { inputStatus: "applied", queueDepth: queueDepth(state.inputs) },
          );
        return refusedButAlive(state, attachment, frame, "unknown-input", now);
      }
      if (frame.outcome === "applied") {
        // Terminal: the entry leaves the queue; only the id survives.
        const inputs = state.inputs.filter((i) => i.id !== target.id);
        return accepted(
          {
            ...state,
            seq,
            inputs,
            appliedInputs: { ...state.appliedInputs, [target.id]: true as const },
            attachment: renewAttachment(attachment, now),
          },
          frame,
          now,
          NO_EFFECTS,
          { inputStatus: "applied", rejections: target.rejections, queueDepth: queueDepth(inputs) },
        );
      }
      // rejected returns to the queue armed for one boundary redelivery,
      // never dropped; queued is the durable accepted disposition.
      const next: QueuedInput =
        frame.outcome === "rejected"
          ? { ...target, status: "outstanding", rejections: target.rejections + 1, redeliver: true }
          : { ...target, status: "queued" };
      const inputs = state.inputs.map((i) => (i.id === next.id ? next : i));
      return accepted(
        { ...state, seq, inputs, attachment: renewAttachment(attachment, now) },
        frame,
        now,
        NO_EFFECTS,
        { inputStatus: next.status, rejections: next.rejections, queueDepth: queueDepth(inputs) },
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
  // Delivery only into a LIVE lease: an expired attachment is takeover-
  // eligible, and handing it new work invites double-application across
  // the handoff. The input still queues, armed for boundary delivery
  // (if this writer recovers) or attach replay (if another takes over).
  const live = AttachmentLedger.isLive(state, now);
  const queued: QueuedInput = {
    id: input.id,
    seq: state.seq + 1,
    text: input.text,
    mode: input.mode,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    status: "outstanding",
    rejections: 0,
    redeliver: !live,
  };
  const frame = inputFrame(queued);
  if (
    !isWireId(input.id) ||
    (input.turnId !== undefined && !isWireId(input.turnId)) ||
    !isWireText(input.text)
  )
    return hostRefusal(state, frame, "invalid-input", now);
  if (
    state.inputs.some((existing) => existing.id === input.id) ||
    Object.hasOwn(state.appliedInputs, input.id)
  )
    return hostRefusal(state, frame, "input-id-reused", now);
  // PLAN 4.4: steer only where the profile allows it - a headless-turn
  // writer can never be interjected mid-turn, so the request itself is a
  // host error there. Other profiles answer through `disposition`.
  if (input.mode === "steer" && state.attachment?.profile === "headless-turn")
    return hostRefusal(state, frame, "steer-unsupported", now);
  const inputs = [...state.inputs, queued];
  return accepted(
    { ...state, seq: queued.seq, inputs },
    frame,
    now,
    live ? [{ type: "send", frame }] : NO_EFFECTS,
    { queueDepth: InputLedger.queueDepth(inputs) },
  );
};

/** Host transition: grant flow credits for the droppable class only
 * (PLAN 4.5). The grant is clamped so outstanding credits never exceed
 * DROPPABLE_QUEUE_MAX - that clamp IS the bounded queue: at most MAX
 * droppable frames can be accepted between render drains. */
export const grantCredit = (state: ChannelState, tokens: number, now: number): ReduceResult => {
  // The host-facing API is exactly as strict as the wire it mirrors
  // (nat-bounded tokens): a negative or fractional grant would drive the
  // balance off the non-negative integers and hold the gate open forever.
  if (!Number.isSafeInteger(tokens) || tokens <= 0)
    return hostRefusal(
      state,
      { kind: "credit", epoch: state.epoch, tokens: 0 },
      "invalid-grant",
      now,
    );
  if (!AttachmentLedger.isLive(state, now))
    return hostRefusal(state, { kind: "credit", epoch: state.epoch, tokens }, "not-attached", now);
  // No seq is minted: seq positions belong to inbound accepted frames and
  // the replayable outbound kinds (input/control carry seq in the wire
  // shapes - D-028's shapes-win rule); credit is unsequenced flow control.
  const granted = CreditLedger.clampedGrant(state, tokens);
  const credits = state.credits + granted;
  const frame: Frame = { kind: "credit", epoch: state.epoch, tokens: granted };
  return {
    verdict: "accepted",
    state: granted === 0 ? state : { ...state, credits },
    effects: granted === 0 ? NO_EFFECTS : [{ type: "send", frame }],
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

export const reduce = (
  state: ChannelState,
  frame: Frame,
  now: number,
  ctx?: ReduceContext,
): ReduceResult => {
  switch (frame.kind) {
    case "attach":
      return reduceAttach(state, frame, now, ctx);
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
