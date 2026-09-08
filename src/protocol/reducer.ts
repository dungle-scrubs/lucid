import { supportsManagedInput } from "./frames.js";
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
 * Deepening (A): the reducer is a facade over three ledgers —
 * AttachmentLedger, InputLedger, and CreditLedger — each owning one
 * discipline in `src/protocol/ledgers/*`. The public surface stays
 * `reduce(state,frame,now,ctx)` plus `enqueueInput`/`grantCredit`/`isLive`,
 * so callers see one seam. Fixing a lease grace touches AttachmentLedger;
 * fixing disposition idempotency touches InputLedger; fixing credit clamp
 * touches CreditLedger — no longer the whole 8-branch switch. The ledgers
 * are exported from `protocol/ledgers` so their invariants are
 * unit-testable without building a full ChannelState.
 * Deletion test: deleting a ledger would scatter its discipline back into
 * the switch and into liveness — two clocks again.
 */

import { recordContextContent, recordContextTurn } from "./context-coverage.js";
import { classOfEventKind, EventKind } from "./events.js";
import type { AttachmentIntent } from "./frames.js";
import {
  type AttachProfile,
  type DetachReason,
  type Disposition,
  type Frame,
  type FrameKind,
  type HarnessName,
  type InputMode,
  isInputMode,
  isWireId,
  isWireText,
  type Lease,
  type ProtocolIssue,
  type RefusalIssue,
} from "./frames.js";
import { AttachmentLedger, LEASE_RENEW_EVERY_MS, LEASE_TTL_MS } from "./ledgers/attachment.js";
import { CreditLedger } from "./ledgers/credit.js";
import { InputLedger } from "./ledgers/input.js";
import type { ProcessOwner } from "./process-owner.js";

export type { RefusalIssue } from "./frames.js";

export const PROTOCOL_VERSION = 1;

// Re-exported for callers that import via reducer (liveness, tests).
// The single source lives in ledgers/attachment.ts.
export { LEASE_RENEW_EVERY_MS, LEASE_TTL_MS };

export interface Attachment extends AttachmentIntent {
  readonly owner?: ProcessOwner;
  readonly profile: AttachProfile;
  /** Attributes identity events to this participation's harness. Naming
   * an interactive harness does not grant ownership of its process. */
  readonly harness?: HarnessName;
  /** Last accepted per-epoch source counter; next event must carry lastN+1. */
  readonly lastN: number;
  readonly lease: Lease;
}

export interface NativeSession {
  readonly current: boolean;
  readonly owner?: ProcessOwner;
  readonly authority: "harness-minted" | "caller-assigned";
  readonly epoch: number;
  readonly profile: AttachProfile;
  readonly seq: number;
  readonly sessionId: string;
  readonly turnId: string;
}

/** Last accepted participation survives detach, even before an identity arrives. */
export interface Participation {
  readonly epoch: number;
  readonly harness?: HarnessName;
  readonly owner?: ProcessOwner;
  readonly profile: AttachProfile;
}

/** Disposition state machine: outstanding -> applied | queued; a rejected
 * disposition returns the input to outstanding (counted), never drops it.
 * "Accepted input" per PLAN 4.3 = durable applied|queued disposition. */
export type InputStatus = "outstanding" | "queued" | "applied";

export interface QueuedInput {
  readonly managed?: true;
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

/** The outstanding question, if any. Set when a `question` event is
 * accepted, preserved across `done { cause: "awaiting-input" }` (that
 * `done` ends the asking turn while the session stays ready, so the
 * question becomes answerable rather than closing), replaced by a second
 * question, and cleared only on three things: an answer applied, the
 * first event of an unrelated turn, and detach. */
export interface OpenQuestion {
  readonly turnId: string;
  readonly question: string;
  /** Options the harness offered, if any. */
  readonly options?: readonly string[];
  readonly recommended?: string;
  /** Reservation for an answer being applied. While set, the question
   * waits for that inputId to reach applied. */
  readonly answeringInputId?: string;
}

export interface ChannelState {
  readonly conversationId: string;
  /** Minted by the host at record creation (D-004); checked only at attach. */
  readonly secret: string;
  /** Last lucid-minted seq - the durable log position. Every accepted frame
   * consumes one,
   * so the space is sparse from a source's view: bookkeeping frames
   * (heartbeat/ack/detach) hold seqs that are never replayable, and the
   * host filters deliverable kinds when honoring replayFrom. */
  readonly seq: number;
  /** Current fencing token; 0 = never attached. Survives detach. */
  readonly epoch: number;
  readonly attachment: Attachment | null;
  readonly lastParticipation: Participation | null;
  readonly terminalParticipations: readonly Participation[];
  readonly lastTerminalParticipation: Participation | null;
  readonly executions: Readonly<Record<string, import("./execution.js").ExecutionState>>;
  readonly completedTurns: Readonly<Record<string, number>>;
  readonly contextCoverage: Readonly<Record<string, number>>;
  readonly contextContent: import("./context-coverage.js").ContextContent;
  readonly contextTurns: Readonly<Record<string, import("./context-coverage.js").ContextTurn>>;
  readonly contextOffers: Readonly<Record<string, import("./context-coverage.js").SessionContext>>;
  readonly explicitAttachments: Readonly<Record<string, number>>;
  /** The newest harness session id seen per harness, attributed by the
   * attachment that was live when its identity event was accepted.
   *
   * A map rather than a walk over history: ChannelState keeps only the
   * CURRENT attachment, so once an epoch increments the harness that held
   * the previous one is gone and there is nothing to walk. Folding
   * accumulates this as it goes, which costs one entry per harness and
   * makes the attach-time lookup O(1). Empty for records written before
   * RFC-03: their events carry no attribution, so they are un-resumable
   * rather than guessed at. */
  readonly harnessSessions: Readonly<Partial<Record<HarnessName, string>>>;
  readonly nativeSessions: Readonly<Partial<Record<HarnessName, NativeSession>>>;
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
  /** Inputs delivered to a harness whose turn has not produced a terminal
   * event — the input backlog (RFC-04 P2), and the quantity
   * INPUT_QUEUE_MAX will bound. Not derivable from `inputs`: a delivered
   * input has already left it. Rises on the applied disposition (the
   * durable delivery record), falls on a turn-terminal event, and resets
   * when the attachment ends because an aborted turn's terminal event is
   * fenced stale-epoch and can never land. InputLedger owns the edges. */
  readonly inFlightInputs: number;
  /** Flow credits granted but not yet consumed by droppable events.
   * Bounded by DROPPABLE_QUEUE_MAX, which is what bounds the number of
   * droppable frames in flight between render drains. */
  readonly credits: number;
  /** The outstanding question, if any. Null when none is open. */
  readonly questionOpen: OpenQuestion | null;
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
  /** ProtocolIssue, not RefusalIssue: a host transition can carry a
   * codec-class issue - `enqueueInput` refuses an unknown mode with
   * `wrong-type` (RFC-05 B4), the same issue the codec gives the same
   * value on the wire. */
  readonly issue?: ProtocolIssue;
  readonly detail?: RefusalDetail;
  /** Input-delivery observability: which input, and the two depth gauges
   * after the transition. queueDepth counts inputs AWAITING a disposition;
   * inFlightInputs counts delivered inputs whose turn has no terminal
   * event yet (RFC-04 P2). They disagree by design since hcn stopped
   * queueing (ADR 0007): an accepted send is answered applied at once, so
   * queueDepth drains to zero while the harness is still behind — only
   * inFlightInputs sees the backlog. */
  readonly inputId?: string;
  readonly queueDepth?: number;
  readonly inFlightInputs?: number;
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
 * INTERACTIVE process only: whether a human-owned process is present. Never feed it the liveness of lucid's own
 * headless child - that would fence a stalled runner against its own
 * recovery. */
export interface Presence {
  readonly processAlive: boolean;
}

/** Host-corroborated facts a transition may consult. ABSENT presence means
 * the host could not corroborate - presence never proves a channel, so
 * absence never blocks (epoch fencing is the defense - D-021). */
export interface ReduceContext {
  readonly ownersDeparted?: true;
  readonly owner?: ProcessOwner;
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
      readonly issue: ProtocolIssue;
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
  lastParticipation: null,
  terminalParticipations: [],
  lastTerminalParticipation: null,
  executions: {},
  completedTurns: {},
  contextCoverage: {},
  contextContent: { current: null, earlier: [] },
  contextTurns: {},
  contextOffers: {},
  explicitAttachments: {},
  turn: null,
  acked: 0,
  seenTurns: {},
  inputs: [],
  appliedInputs: {},
  inFlightInputs: 0,
  credits: 0,
  harnessSessions: {},
  nativeSessions: {},
  questionOpen: null,
});

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

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
  issue: ProtocolIssue,
  now: number,
  detail?: RefusalDetail,
  extra?: Pick<TransitionRecord, "credits" | "queueDepth" | "presence" | "inFlightInputs">,
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
  issue: ProtocolIssue,
  now: number,
  extra?: Pick<TransitionRecord, "credits" | "queueDepth" | "presence" | "inFlightInputs">,
): ReduceResult => {
  const result = refusal(state, frame, issue, now, undefined, extra);
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
    "queueDepth" | "credits" | "inputStatus" | "rejections" | "presence" | "inFlightInputs"
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

/** The `input` frame for a queued input. Exported because live delivery
 * redelivers armed inputs from state (see `runtime.ts`), and a second
 * hand-built frame there would be a mirror of this one — the thing this
 * repo does not do with wire shapes. */
export const inputFrame = (
  input: Pick<QueuedInput, "managed" | "id" | "seq" | "text" | "mode" | "turnId">,
): Frame => ({
  ...(input.managed ? { managed: true } : {}),
  kind: "input",
  seq: input.seq,
  id: input.id,
  text: input.text,
  mode: input.mode,
  ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
});

// Ledgers live in ./ledgers/* — one discipline per module (01).
// The reducer is the facade that orchestrates them.

/** Exported live check delegates to the ledger — one clock, one owner.
 * Hosts consult this, never arithmetic on HEARTBEAT_MS/ATTACH_GRACE_MS. */
export const isLive = (state: ChannelState, now: number): boolean =>
  AttachmentLedger.isLive(state, now);

const renewLease = (lease: Lease, now: number): Lease => AttachmentLedger.renewLease(lease, now);
const renewAttachment = (attachment: Attachment, now: number): Attachment =>
  AttachmentLedger.renewAttachment(attachment, now);

/** A refusal from the CURRENT writer still proves the channel alive: the
 * frame is never applied, but the lease renews. Only post-fence refusals
 * reach this — a stale or unauthenticated writer must never hold the
 * lease open. Ledger owns the lease math, reducer owns the verdict. */
const refusedButAlive = (
  state: ChannelState,
  attachment: Attachment,
  frame: Frame,
  issue: RefusalIssue,
  now: number,
  detail?: RefusalDetail,
  extra?: Pick<TransitionRecord, "credits" | "queueDepth" | "presence">,
): ReduceResult => {
  const renewed = AttachmentLedger.renewAttachment(attachment, now);
  const next = renewed === attachment ? state : { ...state, attachment: renewed };
  return refusal(next, frame, issue, now, detail, extra);
};

const queueDepth = (inputs: readonly QueuedInput[]): number => InputLedger.queueDepth(inputs);

const sendInputs = (
  inputs: readonly QueuedInput[],
  capabilities?: readonly string[],
): readonly Effect[] =>
  inputs
    .filter((input) => !input.managed || supportsManagedInput(capabilities))
    .map((i) => ({ type: "send", frame: inputFrame(i) }));

/** Derive the next questionOpen after an accepted event. A `question`
 * event sets/replaces it; a `done` with awaiting-input does NOT clear it;
 * any other event whose turnId is not the asking turn and not the
 * answer's turn (when answering) clears on the first event of that
 * unrelated turn. */
const isLegacyAnswerDemotion = (message: unknown): boolean => {
  const prefix = "answer demoted: no-open-question for ";
  return (
    typeof message === "string" &&
    message.startsWith(prefix) &&
    isWireId(message.slice(prefix.length))
  );
};

const nextQuestionOpenAfterEvent = (
  current: OpenQuestion | null,
  frame: Extract<Frame, { kind: "event" }>,
  previousTurn: { readonly turnId: string } | null,
): OpenQuestion | null => {
  const ev = frame.event as Record<string, unknown>;
  // A question event opens/replaces the question.
  if (ev.kind === EventKind.question && typeof ev.question === "string" && ev.question !== "") {
    const opts = Array.isArray(ev.options) ? (ev.options as readonly string[]) : undefined;
    const rec = typeof ev.recommended === "string" ? (ev.recommended as string) : undefined;
    return {
      turnId: frame.turnId,
      question: ev.question as string,
      ...(opts !== undefined ? { options: opts } : {}),
      ...(rec !== undefined ? { recommended: rec } : {}),
    };
  }
  if (current === null) return null;
  // The harness can disagree that a question is open: hcn's session holds
  // its own notion of what was asked, and an answer to lucid's newer
  // question can come back `no-open-question`. The demotion path records
  // the divergence as a non-terminal error on the current turn and clears
  // lucid's view, because the harness has said it was wrong.
  if (
    ev.kind === EventKind.error &&
    (Object.hasOwn(ev, "code") ? ev.code === "answer-demoted" : isLegacyAnswerDemotion(ev.message))
  )
    return null;
  // Nothing here reads the terminal cause, and that is the point rather
  // than an omission. The `done` that ends an asking turn - cause
  // `awaiting-input`, named in `harness/events` - carries the asking
  // turn's own id, so the same-turn check below already leaves the
  // question alone. So does any other cause on that turn.
  //
  // Branching on the cause instead would be the mistake RFC-05's R1 was
  // rewritten to avoid: a rule keyed on `done` clears every question
  // before a human can see it. What retires a question is the
  // conversation moving to another turn, and turn identity is what says
  // so.
  const isSameTurn = frame.turnId === current.turnId;
  if (isSameTurn) return current;
  // Unrelated turn: clear only on the first event of that turn (a new
  // turnId vs previousTurn). If we are already in that unrelated turn,
  // we would have cleared on its first event, so nothing to do.
  const isNewTurn = previousTurn === null || previousTurn.turnId !== frame.turnId;
  if (!isNewTurn) return current;
  // If an answer is pending, the answer's turn should not clear. We do
  // not have the answer's turnId directly; the answer input's turnId is
  // the question's turnId, so a new turn after answering is the harness's
  // response turn. Without explicit mapping, we treat any new turn as
  // unrelated and clear. This satisfies the spec's three clear causes
  // while preserving same-turn done.
  return null;
};

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

  // RFC-03 R001: a headless source must say which harness it drives. The
  // frame is well formed - an unknown NAME is refused at the codec - so this
  // is an unsupportable request rather than a malformed one.
  const headless = frame.profile !== "interactive";
  if (headless && frame.harness === undefined)
    return refusal(state, frame, "invalid-grant", now, undefined);
  // Attribution does not grant ownership. Runtime owner checks and the
  // executor lease still govern any later headless takeover (RFC 15).
  const attachHarness = frame.harness;

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
  // RFC-05 Replay: an answer is replayed as queue, never as answer.
  // Attach replays every input still awaiting an applied disposition
  // straight from state.inputs through receive - it does not call
  // enqueueInput again, so no staleness check runs. Rewriting here
  // keeps the words and drops a claim that can no longer be checked.
  const replayedForSend = replayed.map((i) =>
    i.mode === "answer" ? { ...i, mode: "queue" as const } : i,
  );
  return accepted(
    {
      ...state,
      seq: state.seq + 1,
      epoch,
      explicitAttachments:
        frame.attachmentOrigin === "explicit" &&
        frame.explicitAttachmentId !== undefined &&
        !Object.hasOwn(state.explicitAttachments, frame.explicitAttachmentId)
          ? { ...state.explicitAttachments, [frame.explicitAttachmentId]: epoch }
          : state.explicitAttachments,
      terminalParticipations:
        frame.profile === "interactive"
          ? [
              ...state.terminalParticipations,
              {
                epoch,
                profile: frame.profile,
                ...(ctx?.owner === undefined ? {} : { owner: ctx.owner }),
                ...(attachHarness === undefined ? {} : { harness: attachHarness }),
              },
            ]
          : ctx?.ownersDeparted
            ? []
            : state.terminalParticipations,
      lastTerminalParticipation:
        frame.profile === "interactive"
          ? {
              epoch,
              profile: frame.profile,
              ...(ctx?.owner === undefined ? {} : { owner: ctx.owner }),
              ...(attachHarness === undefined ? {} : { harness: attachHarness }),
            }
          : state.lastTerminalParticipation,
      lastParticipation: {
        epoch,
        profile: frame.profile,
        ...(ctx?.owner === undefined ? {} : { owner: ctx.owner }),
        ...(attachHarness === undefined ? {} : { harness: attachHarness }),
      },
      attachment: {
        ...(frame.capabilities === undefined ? {} : { capabilities: frame.capabilities }),
        ...(frame.attachmentOrigin === undefined
          ? {}
          : { attachmentOrigin: frame.attachmentOrigin }),
        ...(frame.explicitAttachmentId === undefined
          ? {}
          : { explicitAttachmentId: frame.explicitAttachmentId }),
        ...(ctx?.owner === undefined ? {} : { owner: ctx.owner }),
        profile: frame.profile,
        lastN: 0,
        lease,
        ...(attachHarness === undefined ? {} : { harness: attachHarness }),
      },
      turn: null,
      // The watermark and the credit balance speak for the CURRENT writer
      // only: acked rebased from what this attach claims durably applied,
      // credits zeroed (the new writer never received the old grants).
      acked: frame.resumeFrom ?? 0,
      credits: 0,
      // Same scope for the input backlog: the takeover aborted the old
      // writer's turns, whose terminal events would be refused stale-epoch,
      // so anything still counted in-flight could never fall out (RFC-04 P2).
      inFlightInputs: 0,
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
          // The session this harness last held in THIS record, if any.
          // Absent covers both an empty record and one whose sessions
          // belong to other harnesses: the answer to "is there one of
          // mine" is no either way (R006).
          ...(attachHarness !== undefined && state.harnessSessions[attachHarness] !== undefined
            ? { resumeSessionId: state.harnessSessions[attachHarness] }
            : {}),
        },
      },
      ...sendInputs(replayedForSend, frame.capabilities),
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
      // RFC-03: attribute an identity to the harness that was live when it
      // was accepted. This is the whole attribution mechanism - done as the
      // fold goes, because after the next attach this attachment is gone.
      const identitySessionId =
        attachment.harness !== undefined &&
        frame.event.kind === "identity" &&
        typeof frame.event.sessionId === "string" &&
        frame.event.sessionId !== ""
          ? frame.event.sessionId
          : undefined;
      const questionOpen = nextQuestionOpenAfterEvent(state.questionOpen, frame, state.turn);
      return accepted(
        {
          ...state,
          seq,
          attachment: {
            ...attachment,
            ...(attachment.owner === undefined ? {} : { owner: attachment.owner }),
            profile: attachment.profile,
            lastN: frame.n,
            lease: renewLease(attachment.lease, now),
            // Carried, not rebuilt: dropping it here would lose attribution
            // on the second event of every attachment.
            ...(attachment.harness === undefined ? {} : { harness: attachment.harness }),
          },
          ...(identitySessionId === undefined || attachment.harness === undefined
            ? {}
            : {
                harnessSessions: {
                  ...state.harnessSessions,
                  [attachment.harness]: identitySessionId,
                },
                nativeSessions: {
                  ...state.nativeSessions,
                  [attachment.harness]:
                    frame.event.authority === "harness-minted" ||
                    frame.event.authority === "caller-assigned"
                      ? {
                          current: true,
                          authority: frame.event.authority,
                          ...(attachment.owner === undefined ? {} : { owner: attachment.owner }),
                          epoch: frame.epoch,
                          profile: attachment.profile,
                          seq,
                          sessionId: identitySessionId,
                          turnId: frame.turnId,
                        }
                      : state.nativeSessions[attachment.harness] === undefined
                        ? undefined
                        : { ...state.nativeSessions[attachment.harness], current: false },
                },
              }),
          turn: sameTurn ? state.turn : { turnId: frame.turnId },
          contextContent: recordContextContent(state.contextContent, "turn", frame.turnId, seq),
          contextTurns: recordContextTurn(
            state.contextTurns,
            frame.turnId,
            frame.epoch,
            attachment.harness,
            frame.event,
          ),
          seenTurns: sameTurn
            ? state.seenTurns
            : { ...state.seenTurns, [frame.turnId]: true as const },
          credits: droppable ? state.credits - 1 : state.credits,
          // A turn's terminal event retires one in-flight input (RFC-04
          // P2): turns finish in order, so count-down by one is exact, and
          // non-terminal kinds leave the backlog alone.
          inFlightInputs: InputLedger.turnEnded(state.inFlightInputs, frame.event.kind),
          completedTurns:
            frame.event.kind === EventKind.done &&
            (frame.event.exitCode === 0 || frame.event.exitCode === null) &&
            frame.event.failure === undefined &&
            (frame.event.cause === "clean" || frame.event.cause === "awaiting-input")
              ? { ...state.completedTurns, [frame.turnId]: seq }
              : state.completedTurns,
          inputs: InputLedger.clearRedeliver(state.inputs, redelivered.length > 0),
          questionOpen,
        },
        frame,
        now,
        redelivered.length === 0
          ? [ack]
          : [ack, ...sendInputs(redelivered, attachment.capabilities)],
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
      if (target?.managed) {
        const execution = state.executions[target.id];
        if (!supportsManagedInput(attachment.capabilities))
          return refusedButAlive(state, attachment, frame, "unknown-input", now);
        if (
          frame.outcome === "applied" &&
          (execution?.kind !== "attempt-started" ||
            execution.epoch !== state.epoch ||
            execution.driver.harness !== attachment.harness)
        )
          return refusedButAlive(state, attachment, frame, "execution-ineligible", now);
      }
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
            // The gauge holds: this input already rose when its FIRST
            // applied disposition landed — the duplicate must not
            // double-count it (RFC-04 P2).
            {
              inputStatus: "applied",
              queueDepth: queueDepth(state.inputs),
              inFlightInputs: state.inFlightInputs,
            },
          );
        return refusedButAlive(state, attachment, frame, "unknown-input", now);
      }
      if (frame.outcome === "applied") {
        // Terminal: the entry leaves the queue; only the id survives.
        const inputs = state.inputs.filter((i) => i.id !== target.id);
        // Applied is also the durable record of DELIVERY, so this is the
        // in-flight backlog's rise (RFC-04 P2).
        const inFlightInputs = InputLedger.inputDelivered(state.inFlightInputs);
        // R1: an answer reaching applied clears the question it answers.
        // The answering reservation belongs to the question it was made
        // against, so a late disposition for an old question does not clear
        // a newer one (replaced question takes its own reservation with it).
        const questionOpen =
          state.questionOpen?.answeringInputId === frame.inputId ? null : state.questionOpen;
        return accepted(
          {
            ...state,
            seq,
            inputs,
            inFlightInputs,
            appliedInputs: { ...state.appliedInputs, [target.id]: true as const },
            attachment: renewAttachment(attachment, now),
            questionOpen,
          },
          frame,
          now,
          NO_EFFECTS,
          {
            inputStatus: "applied",
            rejections: target.rejections,
            queueDepth: queueDepth(inputs),
            inFlightInputs,
          },
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
        {
          inputStatus: next.status,
          rejections: next.rejections,
          queueDepth: queueDepth(inputs),
          // Neither edge of this disposition delivers anything: queued
          // parks the input in lucid's own queue, rejected hands it back.
          inFlightInputs: state.inFlightInputs,
        },
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
      // rather than leaving a dangling turn no writer could ever end. Its
      // in-flight inputs die with it for the same reason: no terminal
      // event of theirs can ever be folded (RFC-04 P2).
      return accepted(
        { ...state, seq, attachment: null, turn: null, inFlightInputs: 0, questionOpen: null },
        frame,
        now,
        state.turn === null ? NO_EFFECTS : [{ type: "abort-turn", turnId: state.turn.turnId }],
      );
  }
};

/** Host transition: lucid queues an input for delivery to the source. The
 * minted seq and idempotent id travel on the wire, so replay and boundary
 * redelivery can re-deliver without double-application. Refuses
 * `input-queue-full` when the conversation already holds INPUT_QUEUE_MAX
 * inputs in flight (RFC-04): the refusal is the whole answer - this is a
 * policy on durable state, and blocking would hang a caller that has
 * nothing to wait on. */
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
  // RFC-05 B4: a durable input is a log entry whose payload reaches this
  // reducer during a fold without ever passing decodeFrame - the fold
  // types it by claim (`validEntry` checks the envelope only), so the
  // InputMode annotation above proves nothing at runtime. The codec's
  // enumOf check stays (failing early is better); THIS check is the one
  // the compatibility claim rests on, because every input reaches it,
  // from the wire or out of a file. Checked before the id/text checks so
  // a mode this build cannot even name reports `wrong-type` - the same
  // issue the codec gives the same value on the wire - whatever else the
  // payload carries.
  if (!isInputMode(input.mode)) return hostRefusal(state, frame, "wrong-type", now);
  // RFC-05 B3 + Message Formats: an answer without a wire-valid turnId is
  // malformed, not stale. Wire validity is first in the fixed refusal
  // order so a malformed frame reports that instead of a staleness
  // problem that would send someone looking in the wrong place.
  if (input.mode === "answer" && (input.turnId === undefined || !isWireId(input.turnId)))
    return hostRefusal(state, frame, "answer-needs-turn", now);
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
  // PLAN 4.4 + RFC-05 R6: steer and answer only where the profile allows
  // it - a headless-turn writer has no session to steer or answer into,
  // so the request itself is a host error there. A dedicated issue
  // rather than a generic one, and checked before staleness or capacity
  // in the fixed order.
  if (input.mode === "steer" && state.attachment?.profile === "headless-turn")
    return hostRefusal(state, frame, "steer-unsupported", now);
  if (input.mode === "answer" && state.attachment?.profile === "headless-turn")
    return hostRefusal(state, frame, "answer-unsupported", now);
  // RFC-05 R4,R5: an answer naming a turn that is not the open
  // question, or when no question is open, or while one answer is
  // already pending, is stale. Refused stale-answer does not consume
  // the question, so the human can try again with a fresh id.
  if (input.mode === "answer") {
    if (
      state.questionOpen === null ||
      state.questionOpen.turnId !== input.turnId ||
      state.questionOpen.answeringInputId !== undefined
    )
      return hostRefusal(state, frame, "stale-answer", now);
  }
  // RFC-04: the input-direction bound. The gauge it reads is durable
  // state, so the refusal is too - a conversation already holding
  // INPUT_QUEUE_MAX delivered-but-unfinished turns says no to the next
  // send instead of letting the backlog grow past the bound silently.
  // Checked after the id checks on purpose: a retried id at the bound is
  // a redelivery asking after an input lucid already holds, and
  // input-id-reused is the true answer for it.
  // Capacity is last because it is the only refusal that becomes false
  // on its own.
  if (InputLedger.atCapacity(state.inFlightInputs))
    return hostRefusal(state, frame, "input-queue-full", now, {
      queueDepth: queueDepth(state.inputs),
      inFlightInputs: state.inFlightInputs,
    });
  const inputs = [...state.inputs, queued];
  // An accepted answer reserves the question until its applied
  // disposition lands. The reservation belongs to the question it was
  // made against, so a late disposition for an old question does not
  // clear a newer one (the replaced question carried its reservation
  // with it).
  const questionOpen =
    input.mode === "answer" && state.questionOpen !== null
      ? { ...state.questionOpen, answeringInputId: input.id }
      : state.questionOpen;
  return accepted(
    {
      ...state,
      seq: queued.seq,
      inputs,
      questionOpen,
      contextContent: recordContextContent(state.contextContent, "input", input.id, queued.seq),
    },
    frame,
    now,
    live ? [{ type: "send", frame }] : NO_EFFECTS,
    // Enqueue is not delivery: the backlog rises only when the applied
    // disposition lands. The pair on one line shows both gauges where an
    // operator pages on them (RFC-04 P2).
    { queueDepth: InputLedger.queueDepth(inputs), inFlightInputs: state.inFlightInputs },
  );
};

export function enqueueManagedInput(
  state: ChannelState,
  input: Parameters<typeof enqueueInput>[1],
  now: number,
): ReduceResult {
  const result = enqueueInput(state, input, now);
  if (result.verdict !== "accepted") return result;
  return {
    ...result,
    effects: supportsManagedInput(state.attachment?.capabilities)
      ? result.effects.map((effect) =>
          effect.type === "send" && effect.frame.kind === "input"
            ? { type: "send", frame: { ...effect.frame, managed: true } }
            : effect,
        )
      : [],
    state: {
      ...result.state,
      executions: {
        ...state.executions,
        [input.id]: { kind: "requested", attempt: 0, actions: {} },
      },
      inputs: result.state.inputs.map((entry) =>
        entry.id === input.id ? { ...entry, managed: true } : entry,
      ),
    },
  };
}

/** Host transition: grant credits, clamped to the bounded droppable queue. */
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

/** Admission refusals preserve the pre-transaction state and emit the usual wire refusal. */
export const refuseInputAdmission = (
  state: ChannelState,
  input: { id: string; text: string; mode: InputMode },
  issue: ProtocolIssue,
  now: number,
): ReduceResult => refusal(state, { kind: "input", seq: state.seq, ...input }, issue, now);
