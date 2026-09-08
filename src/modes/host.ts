import { comparisonMetadata } from "../protocol/comparison-note.js";
import { createComparisonDelivery } from "./comparison-delivery.js";
/**
 * HeadlessHost — the deep module that owns the headless turn lifecycle.
 *
 * `src/modes/headless.ts` previously owned two adapters (`openHeadlessSession`
 * vs `openHeadlessTurns`) each re-implementing: currentTurnId pump,
 * FIFO shape (`expectedTurns` vs `queue + resumeId`), receive() switch
 * (input → disposition, credit → sequencer), and close/detach wiring.
 * The TurnSequencer (07) extracted the credit spine (n / balance / pending /
 * detachOnce), but the turn-lifecycle — one persistent process vs per-turn
 * process, queued→applied disposition at boundary — stayed duplicated.
 * Fixing a disposition edge fixed only one adapter; a third mode would be
 * a third copy.
 *
 * Now one module owns the whole discipline — turnId sequencing, the
 * FIFO/disposition lifecycle, receive + credit forwarding, pump over the
 * Runner's turns, and single detachOnce — and hosts it behind a small
 * strategy table. The two strategies differ only in Runner invocation
 * (openSession vs streamTurn) and input timing (session: send now,
 * turn: queue between turns). The public surface stays
 * `createHeadlessHost(deps, profile) → SourceChannel` plus the two thin
 * `openHeadlessSession` / `openHeadlessTurns` adapters that preserve the
 * existing import path. The deletion test passes: deleting this module
 * would scatter FIFO + turnId + receive + detach across every headless
 * mode.
 *
 * What it is NOT: it is not the flock, the durable log, or the presence
 * lock — it drives a harness through its Runner and speaks the protocol
 * via sendFrame, hosted by the store.
 */

import type { HarnessEvent } from "../harness/events.js";
import {
  type HarnessName,
  type HarnessRunner,
  HarnessSpawnError,
  type SessionHandle,
} from "../harness/runner.js";
import { composeAnnotationPrompt } from "../protocol/annotations.js";
import {
  ARTIFACT_PREAMBLE_MARKER,
  type ArtifactState,
  composeArtifactPrompt,
  composeArtifactState,
  detectArtifactBlocks,
  quoteForRefusal,
} from "../protocol/artifacts.js";
import { EventKind } from "../protocol/events.js";
import type { NativeIntent } from "../protocol/execution.js";
import { ARTIFACT_BYTES_MAX } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import type { Frame, InputMode, ReduceResult } from "../protocol/index.js";
import { applyPatch, parsePatchBody } from "../protocol/patch.js";
import { ContextPreparationError } from "../store/conversation-context.js";
import type { ConversationHost } from "../store/conversation-host.js";
import { classifyStoreFailure, type StoreFailureCode } from "../store/errors.js";
import { ExecutionSettlementError } from "./managed-execution.js";
import { createSequencer } from "./sequencer.js";

/** How long a harness may say nothing after being handed an input before
 * lucid records that it has.
 *
 * A harness can legitimately think for a long time, so this is generous. It
 * is not a timeout and nothing is cancelled: the input stays delivered and
 * the turn stays open. All it does is turn silence into a fact in the
 * record, because silence and working were indistinguishable — a wedged
 * session held eight inputs for ninety minutes and the log said nothing at
 * all between them. */
export const STALL_MS = 90_000;

const readForArtifact = (
  deps: HeadlessDeps,
  ctx: HostContext,
  operation: "artifact-state" | "patch-base",
  artifactId: string,
  version: number,
): ReturnType<ArtifactHost["readArtifact"]> | "busy" | undefined => {
  try {
    return deps.host.readArtifact(artifactId, version);
  } catch (cause) {
    if (classifyStoreFailure(cause) === "record-busy") {
      ctx.warning(
        {
          kind: EventKind.error,
          code: "record-busy",
          message: `${operation === "patch-base" ? "E-PATCH-09" : "E-LOG-01"} record-busy: append lock for artifact ${artifactId}`,
          terminal: false,
        },
        operation,
        artifactId,
      );
    } else {
      ctx.stop({
        kind: "store-failed",
        code: classifyStoreFailure(cause) ?? "record-unreadable",
        operation,
        artifactId,
      });
    }
    return ctx.isStopped() ? undefined : "busy";
  }
};

const artifactState = (
  deps: HeadlessDeps,
  ctx: HostContext,
): { artifacts: ArtifactState[]; busy: string[] } => {
  const artifacts: ArtifactState[] = [];
  const busy: string[] = [];
  for (const [artifactId, version] of [...deps.host.artifactHeads()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const one = readForArtifact(deps, ctx, "artifact-state", artifactId, version);
    if (one === undefined) break;
    if (one === "busy") {
      busy.push(artifactId);
      continue;
    }
    if (one === null) continue;
    artifacts.push({
      artifactId,
      version,
      author: one.author,
      ...(one.basedOn === undefined ? {} : { basedOn: one.basedOn }),
      ...(one.values === undefined ? {} : { values: one.values }),
      ...(one.author === "human" || ctx.owedBytes.has(artifactId) ? { bytes: one.bytes } : {}),
    });
    ctx.owedBytes.delete(artifactId);
  }
  return { artifacts, busy };
};

const composeAvailableState = (prompt: string, state: ReturnType<typeof artifactState>): string => {
  const composed = composeArtifactState(prompt, state.artifacts);
  return state.busy.length === 0
    ? composed
    : state.busy
        .map(
          (id) =>
            `Artifact ${quoteForRefusal(id)} is busy; its state is omitted from this prompt.\n`,
        )
        .join("") + composed;
};

/** What sendFrame returns. */
type SendResult = ReduceResult | { readonly verdict: "refused"; readonly issue: string };

/** RFC-12: why a source stopped answering on its own. The owner (the
 * honor wrapper, the runtime) needs the difference: a driver change asks
 * for a re-spawn, a refused spawn asks for a fallback to the driver in
 * force, and a plain end asks for nothing. */
export type SourceEnd =
  | { readonly kind: "driver-change" }
  | { readonly kind: "open-refused"; readonly message: string }
  | { readonly kind: "closed" }
  | {
      readonly kind: "store-failed";
      readonly code: StoreFailureCode;
      readonly operation: string;
      readonly artifactId?: string;
    };

export interface ArtifactHost
  extends Pick<
    ConversationHost,
    | "cursor"
    | "collectEffects"
    | "advanceCursor"
    | "artifactHeads"
    | "readArtifact"
    | "writeArtifact"
  > {
  readonly comparisonSnapshot?: ConversationHost["comparisonSnapshot"];
  readonly inputStatus?: (id: string) => string | undefined;
}

export const hostSeamFor = (host: ConversationHost): ArtifactHost => ({
  comparisonSnapshot: (id) => host.comparisonSnapshot(id),
  inputStatus: (id) => host.state().inputs.find((input) => input.id === id)?.status,
  cursor: () => host.cursor(),
  collectEffects: (offset) => host.collectEffects(offset),
  advanceCursor: (offset) => host.advanceCursor(offset),
  artifactHeads: () => host.artifactHeads(),
  readArtifact: (id, version) => host.readArtifact(id, version),
  writeArtifact: (params) => host.writeArtifact(params),
});

export interface HeadlessDeps {
  readonly onDispatchRejected?: (
    turnId: string,
    evidence: "harness-refusal" | "dispatch-not-called",
  ) => void;
  readonly managed?: boolean;
  readonly explicitAttachmentId?: string;
  readonly onAttached?: () => readonly Frame[];
  readonly onTurnSettled?: (turnId: string) => void;
  /** Complete context and persist its authorization before external work.
   * A ready prompt includes protocol teaching and every current artifact's
   * bytes, including resynchronization after a refused patch. The host adds
   * no material after this callback has accounted for the final prompt.
   * Held inputs keep their queued disposition and do not block later inputs. */
  readonly prepareTurn?: (input: {
    readonly inputId: string;
    readonly signal: AbortSignal;
    readonly text: string;
    readonly turnId: string;
    readonly profile: "headless-turn" | "headless-session";
    readonly native: NativeIntent;
  }) => Promise<
    | { readonly kind: "held" }
    | {
        readonly kind: "ready";
        readonly prompt: string;
        readonly native: NativeIntent;
        readonly notice?: string;
      }
  >;
  /** Validate the exact identity immediately before each external process. */
  readonly beforeProcess?: (resume: string | undefined, signal: AbortSignal) => Promise<void>;
  readonly owner?: import("../protocol/process-owner.js").ProcessOwner;
  readonly cwd?: string;
  readonly harness: HarnessName;
  readonly conversationId: string;
  readonly secret: string;
  readonly runner: HarnessRunner;
  /** Routing, passed through to hcn: a model within the harness, and a
   * provider for the harnesses that express one (pi). Absent means the
   * harness's own default. */
  readonly model?: string;
  readonly provider?: string;
  /** RFC-12: the effort dimension, rendered by the hcn runner as
   * `hcn run --effort` and (since hcn 0.6.0) `hcn session --effort`, so
   * both headless profiles express it and the honor rule switches on it. */
  readonly effort?: string;
  /** RFC-12 honor: asked at a turn boundary, before the input in hand is
   * handed to the harness. True means "do not hand it over - end this
   * source": the input is still outstanding in the record, and the source
   * that replaces this one replays it through its attach. Absent means no
   * honor rule and every hand-over proceeds. */
  readonly driverChangeAtBoundary?: () => boolean;
  /** RFC-12 honor: fired once when this source stops answering on its own,
   * with the reason (see SourceEnd). */
  readonly onEnded?: (end: SourceEnd) => void;
  /** Notices recorded after attach and before replay starts a turn. */
  readonly notes?: readonly string[];
  /** RFC-12 honor: this source was opened as a driver change, so its first
   * turn probes for an invocation refusal before the input is consumed
   * (see turnStrategy). */
  readonly probeFirstTurn?: boolean;
  /** Lucid mints headless turnIds (PLAN 4.3); injected for determinism. */
  readonly mintTurnId: () => string;
  /** Injected so the stall watchdog is testable without waiting. */
  readonly now?: () => number;
  /** How long a handed-over input may produce nothing before the silence is
   * recorded. Injected for tests; production uses STALL_MS. */
  readonly stallMs?: number;
  /** How often the watchdog looks. Injected for tests. */
  readonly stallTickMs?: number;
  /** The in-process channel to the host. */
  readonly sendFrame: (frame: Frame) => SendResult;
  readonly host: ArtifactHost;
}

export interface SourceChannel {
  /** Includes preparation work that has not opened a native turn yet. */
  readonly busy?: () => boolean;
  /** Built-in sources settle only after their owned process cleanup completes. */
  readonly settled: Promise<void>;
  /** Host -> source frames (input, control, credit, lease, event-ack). */
  readonly receive: (frame: Frame) => void;
  readonly close: () => void;
  readonly recordChanged?: () => void;
}

export { HeadlessError } from "./sequencer.js";

// Artifact handling helper — owns version assignment and refusal recording.
// Lucid assigns version, author, hash; agent chooses id and replaces.
// See RFC-06 Emission.
const handleArtifactMessage = (
  text: string,
  turnId: string,
  deps: HeadlessDeps,
  ctx: HostContext,
): void => {
  const detections = detectArtifactBlocks(text);
  if (detections.length === 0) return;
  // Local map for versions assigned earlier in this same message, so two
  // blocks with same id in one message see each other in order.
  const localVersions = new Map<string, number>();
  for (const d of detections) {
    if ("malformed" in d) {
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact malformed: ${d.malformed}`,
        terminal: false,
      });
      continue;
    }
    const { header, bytes } = d.block;
    const isPatch = header.form === "patch";
    // Every artifact this conversation holds, and the current version of
    // each. One pass, because the identity check needs the whole set and the
    // version lookup needs one entry of it.
    const held = new Map(deps.host.artifactHeads());
    // Artifacts created by an earlier block of this same message count as
    // held. Otherwise a message that creates the artifact and then revises
    // it would refuse its own second block.
    for (const [id, v] of localVersions) {
      if ((held.get(id) ?? 0) < v) held.set(id, v);
    }

    // RFC-09 R2. A conversation holds one artifact, so an emission naming a
    // different one is refused rather than folded in: the agent chose that
    // id, and quietly substituting another would make its own instruction
    // mean something else and land the document under a name it did not
    // choose.
    //
    // First among the refusals for a block whose header parsed. Malformed
    // and an unrecognised `form` already refused above, inside the parser,
    // because until the header parses there is no id to check. Identity goes
    // ahead of size and of the patch checks because its answer makes them
    // moot: an emission for a document this conversation does not hold does
    // not need its body measured or its edits parsed, and reporting a size
    // refusal for an artifact that was never going to be accepted tells the
    // agent to fix the wrong thing.
    if (held.size > 0 && !held.has(header.id)) {
      const names = [...held.keys()].map((id) => quoteForRefusal(id)).join(", ");
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact ${header.id} refused: E-ART-09 second-artifact: this conversation holds ${names}. Reuse it, or emit the whole document under it to replace what it holds.`,
        terminal: false,
      });
      continue;
    }

    // A patch body is a description of edits, not a document, so the size
    // check below would measure the wrong thing and name a problem that is
    // not size. The document a patch produces is checked once it exists.
    if (!isPatch && bytes.length > ARTIFACT_BYTES_MAX) {
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact ${header.id} too large: ${bytes.length} > ${ARTIFACT_BYTES_MAX}`,
        terminal: false,
      });
      continue;
    }
    const current = held.get(header.id) ?? 0;

    // RFC-08 R1: a patch is a revision, never a creation. There is nothing
    // to anchor against without a version to anchor in, so both of these
    // refuse rather than starting the artifact from the patch body.
    if (isPatch && (header.replaces === null || current === 0)) {
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message:
          current === 0
            ? `artifact ${header.id} refused: E-PATCH-01 patch-without-base: no such artifact to patch — emit the whole document to create it`
            : `artifact ${header.id} refused: E-PATCH-01 patch-without-base: a patch must name the version it replaces`,
        terminal: false,
      });
      continue;
    }

    if (current === 0) {
      // Unknown id — starts new artifact at v1, regardless of replaces.
      const res = deps.host.writeArtifact({
        artifactId: header.id,
        version: 1,
        author: "agent",
        contentType: header.contentType,
        bytes,
      });
      if (res.verdict === "accepted") {
        localVersions.set(header.id, 1);
      } else {
        ctx.sequencer.emit(turnId, {
          kind: EventKind.error,
          message: `artifact ${header.id} not stored: ${res.issue}`,
          terminal: false,
        });
      }
      continue;
    }
    // Known id — replaces must be current, else stale.
    if (header.replaces !== current) {
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact ${header.id} stale replaces: agent said ${String(header.replaces)}, current is ${current}`,
        terminal: false,
      });
      continue;
    }
    // What actually gets stored. For a whole form it is what the agent sent.
    // For a patch it is what the edits produce, and it is appended exactly as
    // a whole form is: same entry, same author, same hash over the same kind
    // of bytes. The patch is never stored, and nothing in the record says a
    // version arrived as one.
    let document = bytes;
    if (isPatch) {
      const parsed = parsePatchBody(bytes);
      if ("refused" in parsed) {
        ctx.sequencer.emit(turnId, {
          kind: EventKind.error,
          message: `artifact ${header.id} refused: ${parsed.refused}`,
          terminal: false,
        });
        continue;
      }
      // `current` already folds in versions written by an earlier block of
      // this same message, so a second block anchors against what the first
      // one produced rather than silently against the version before it.
      const base = readForArtifact(deps, ctx, "patch-base", header.id, current);
      if (base === undefined) return;
      if (base === "busy") continue;
      if (base?.bytes === undefined) {
        ctx.sequencer.emit(turnId, {
          kind: EventKind.error,
          message: `artifact ${header.id} refused: v${current} could not be read, so there is nothing to patch`,
          terminal: false,
        });
        continue;
      }
      const applied = applyPatch(base.bytes, parsed.edits);
      if ("refused" in applied) {
        // Only for an anchor that did not match. The other refusals say what
        // is wrong with the patch itself, and the agent can fix those from
        // the reason alone; this one means its picture of the document has
        // drifted, and no reason can repair that.
        if (applied.refused.includes("E-PATCH-02")) ctx.owedBytes.add(header.id);
        ctx.sequencer.emit(turnId, {
          kind: EventKind.error,
          message: `artifact ${header.id} refused: ${applied.refused}`,
          terminal: false,
        });
        continue;
      }
      document = applied.document;
      // The result is the only thing left bounding a patch. Under the whole
      // form the document also has to fit inside a message, which caps it
      // well below this; a patch carries only the edits, so this check is
      // what holds.
      if (document.length > ARTIFACT_BYTES_MAX) {
        ctx.sequencer.emit(turnId, {
          kind: EventKind.error,
          message: `artifact ${header.id} refused: E-PATCH-06 patch-result-too-large: ${document.length} > ${ARTIFACT_BYTES_MAX}`,
          terminal: false,
        });
        continue;
      }
    }
    const next = current + 1;
    const res = deps.host.writeArtifact({
      artifactId: header.id,
      version: next,
      author: "agent",
      contentType: header.contentType,
      bytes: document,
    });
    if (res.verdict === "accepted") {
      localVersions.set(header.id, next);
    } else {
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact ${header.id} v${next} not stored: ${res.issue}`,
        terminal: false,
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Shared host context — sequencer + turnId + expected FIFO owned once
// ---------------------------------------------------------------------------

interface HostContext {
  preparedNotice(message: string | undefined): void;
  handedOver(): void;
  isStopped(): boolean;
  stop(end: Extract<SourceEnd, { kind: "store-failed" }>): void;
  warning(event: HarnessEvent, operation: string, artifactId: string): void;
  readonly sequencer: ReturnType<typeof createSequencer>;
  /** The harness session lucid says to continue, from attach-ok. Absent
   * means open fresh (RFC-03). */
  readonly resumeSessionId?: string;
  getTurnId(): string;
  nextTurnId(): string;
  readonly expected: Array<{ inputId: string; applied: boolean }>;
  /** Say that a reason this session is over is already in the record. The
   * pump reports the end too, and without this one failure reads as two. */
  reported(): void;
  /** RFC-12: the boundary question - has the driver preference changed so
   * this source should not hand its input over? */
  boundaryChange(): boolean;
  /** RFC-12: this source is ending because the driver changed; its end is
   * a hand-off, not a death. */
  driverChange(): void;
  /** RFC-12: this source's spawn was refused; carry the message to the
   * owner through SourceEnd. */
  openRefused(message: string): void;
  /** Artifact ids whose current version owes the agent a look, because its
   * own patch just failed to anchor against it. Per host, not per module:
   * one process runs several conversations and they must not read each
   * other's debts. */
  readonly owedBytes: Set<string>;
  readonly comparison: ReturnType<typeof createComparisonDelivery>;
  delivering(): void;
}

interface StrategyHandle {
  recordChanged(): void;
  /** Handle an input arrival — must disposition via sequencer and arrange
   *  the prompt for the runner (send now vs queue). `mode` decides whether
   *  a mid-turn arrival interrupts: `steer` goes through at once, `queue`
   *  waits for the boundary. */
  onInput(id: string, text: string, mode: InputMode): void;
  /** Async iterable of turns, each turn iterable of HarnessEvents. The host
   *  pumps this, shifting expected at each boundary and emitting events
   *  under the current turnId. */
  readonly turns: AsyncIterable<AsyncIterable<HarnessEvent>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session strategy — one persistent process, inputs sent via session.send
// ---------------------------------------------------------------------------

const sessionStrategy = (
  deps: HeadlessDeps & { readonly sessionId: string },
  ctx: HostContext,
): StrategyHandle => {
  // Opening crosses a process boundary now, so it is a promise. The host's
  // surface stays synchronous: everything that needs the session awaits this
  // one handle rather than the caller learning about the wait.
  // hcn session carries --model, --provider and (since 0.6.0) --effort.
  const cancellation = new AbortController();
  const open = (resume: string | undefined) =>
    deps.runner.openSession({
      signal: cancellation.signal,
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      harness: deps.harness,
      sessionId: deps.sessionId,
      // Continue the session this harness last held in this record, if lucid
      // found one. The id comes from attach-ok and nowhere else.
      ...(resume === undefined ? {} : { resume }),
      ...(deps.model === undefined ? {} : { model: deps.model }),
      ...(deps.provider === undefined ? {} : { provider: deps.provider }),
      ...(deps.effort === undefined ? {} : { effort: deps.effort }),
    });
  const deferred = Promise.withResolvers<SessionHandle>();
  const opening = deferred.promise;
  let openingStarted = false;
  const startOpening = (resume: string | undefined): Promise<SessionHandle> => {
    if (openingStarted) return opening;
    openingStarted = true;
    deferred.resolve(
      deps.beforeProcess
        ? deps.beforeProcess(resume, cancellation.signal).then(() => {
            if (cancellation.signal.aborted) throw new Error("Source closed before process start");
            return open(resume);
          })
        : open(resume),
    );
    return opening;
  };
  if (!deps.prepareTurn) startOpening(ctx.resumeSessionId);
  // A failure to open must not become an unhandled rejection. It must also
  // not be silent: a session hcn refuses (a harness with no session mode, an
  // unknown model, a provider it cannot express) ends the source exactly like
  // a clean shutdown, so without a record the durable log cannot tell a
  // refusal from a crash. Found by running the seam against codex, which has
  // no session mode: lucid detached correctly and said nothing.
  opening.catch(() => {});
  let cleanup: Promise<void> | undefined;
  const closeNative = (): Promise<void> => {
    cleanup ??= opening
      .then((session) => session.close())
      .then(
        () => {},
        () => {},
      );
    return cleanup;
  };

  // Whether a turn is running right now. Set when the pump takes a turn off
  // the session and cleared when that turn's events end - the boundary is an
  // event the pump already sees, so nothing here polls for it.
  let turnRunning = false;
  let closed = false;
  // Inputs that arrived mid-turn in `queue` mode, waiting for the boundary. Answers and steers are never held (RFC-05 R3).
  const waiting: Array<{ id: string; text: string; mode: InputMode }> = [];
  let sessionIdentity = ctx.resumeSessionId;

  const arrival = new Map<string, number>();
  const received = new Set<string>();
  const reject = (id: string, reason: string): void => {
    received.delete(id);
    ctx.sequencer.disposition(id, "rejected", reason);
  };
  let artifactPreambleSent = false;

  const refusePrepared = (cause: unknown, fallbackCode: string): void => {
    if (closed) return;
    closed = true;
    waiting.length = 0;
    cancellation.abort();
    if (!openingStarted) deferred.reject(cause);
    void closeNative();
    const storeCode = classifyStoreFailure(cause);
    if (storeCode !== undefined) {
      ctx.stop({ kind: "store-failed", code: storeCode, operation: "turn" });
      return;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    ctx.sequencer.emit(ctx.getTurnId(), {
      kind: EventKind.error,
      code:
        cause instanceof HubError || cause instanceof ExecutionSettlementError
          ? cause.code
          : fallbackCode,
      message,
      terminal: true,
    });
    ctx.reported();
    ctx.openRefused(message);
  };

  // RFC-12: end this source so its owner can re-open under the changed
  // preference. Anything still waiting for a boundary is dropped here, not
  // lost: no waiting input has an applied disposition, so each is still
  // outstanding in the record and the replacement source's attach replays
  // it - the same code path a restart uses.
  const endAsDriverChange = (): void => {
    if (closed) return;
    closed = true;
    waiting.length = 0;
    ctx.driverChange();
    if (!openingStarted) deferred.reject(new Error("Driver changed before prepared input"));
    void closeNative();
  };

  const drainWaiting = (): void => {
    if (closed || ctx.isStopped()) return;
    if (waiting.length > 0 && ctx.boundaryChange()) {
      endAsDriverChange();
      return;
    }
    const due = waiting.splice(0, waiting.length);
    let dispatched = false;
    for (const input of due) {
      if ((!deps.prepareTurn || !dispatched) && ctx.comparison.eligible(input.id, input.text)) {
        sendNow(input.id, input.text, input.mode);
        dispatched = true;
      } else waiting.push(input);
    }
  };

  const sendNow = (id: string, text: string, mode: InputMode): void => {
    if (closed) return;
    // RFC-06: the artifact protocol preamble is said once per session. It is
    // instructions, and they do not change.
    //
    // Nothing else here is like that, and all three used to sit behind the
    // same flag. The artifact state describes a record that changes under
    // the session — a person saving a version is exactly that — so from the
    // second input onward the agent was told nothing about it, and would
    // name a stale version in its next revision for a reason neither side
    // could see. The annotation preamble belongs to the batch of notes in
    // the input carrying it, so it goes with every batch or with none.
    //
    // Not for answers: an answer is raw text through the harness answer
    // path, not a prompt.
    let composed = text;
    if (
      mode !== "answer" &&
      !(deps.prepareTurn && mode === "queue") &&
      comparisonMetadata(text).kind === "none"
    ) {
      let framed = composeAnnotationPrompt(text);
      if (!artifactPreambleSent) {
        const withProtocol = composeArtifactPrompt(framed, "headless-session");
        if (withProtocol !== framed || text.startsWith(ARTIFACT_PREAMBLE_MARKER)) {
          artifactPreambleSent = true;
        }
        framed = withProtocol;
      }
      composed = composeAvailableState(framed, artifactState(deps, ctx));
    }
    if (ctx.isStopped()) return;
    // hcn answers a send with exactly one disposition, and it answers
    // before it opens the turn. So the reply is awaited and recorded when
    // it lands: one disposition per input, the same as before, just no
    // longer decided locally.
    if (mode === "answer") {
      // An answer is delivered through the harness's answer path, not its
      // send path. lucid passes raw text and lets hcn compose the wrapper
      // (RFC-05 R7) — the same discipline as never mirroring the harness
      // normaliser's vocabulary anywhere else.
      void opening
        .then((session) => session.answer(id, composed))
        .then((ans) => {
          if (ans.disposition === "rejected" && ans.reason === "no-open-question") {
            // The harness disagrees that a question is open. lucid replaced
            // it, the harness did not. The answer is refused as an internal
            // step, not a result — exactly one outcome is recorded per input
            // id, and it is the outcome of the whole attempt.
            // The divergence is a non-terminal error on the current turn,
            // not a note on the disposition (that reaches the durable frame
            // but never the transcript).
            ctx.sequencer.emit(ctx.getTurnId(), {
              kind: EventKind.error,
              code: "answer-demoted",
              inputId: id,
              message: `answer demoted: no-open-question for ${id}`,
              terminal: false,
            });
            return opening
              .then((session) => session.send(id, text))
              .then((sent) => {
                if (sent.disposition === "rejected") {
                  reject(id, sent.reason ?? "send rejected");
                  return;
                }
                ctx.expected.push({ inputId: id, applied: true });
                ctx.sequencer.disposition(id, "applied");
              })
              .catch(() => {
                reject(id, "session closed");
              });
          }
          if (ans.disposition === "rejected") {
            reject(id, ans.reason ?? "answer rejected");
            return;
          }
          ctx.expected.push({ inputId: id, applied: true });
          ctx.sequencer.disposition(id, "applied");
        })
        .catch(() => {
          reject(id, "session closed");
        });
      return;
    }
    const prepare = deps.prepareTurn;
    const preparedTurnId = ctx.getTurnId();
    let sendCalled = false;
    let failureCode = "E-HUB-06";
    const delivery =
      prepare && mode === "queue"
        ? (async () => {
            turnRunning = true;
            ctx.sequencer.disposition(id, "queued");
            if (openingStarted && sessionIdentity === undefined)
              throw new HubError(
                "The running harness has not reported its native session identity. Keep this input pending.",
                "E-HUB-03",
              );
            const prepared = await prepare({
              inputId: id,
              signal: cancellation.signal,
              text,
              turnId: ctx.getTurnId(),
              profile: "headless-session",
              native:
                sessionIdentity === undefined
                  ? { kind: "fresh" }
                  : { kind: "resume", sessionId: sessionIdentity },
            });
            if (closed || ctx.isStopped()) return null;
            if (prepared.kind === "held") {
              turnRunning = false;
              drainWaiting();
              return null;
            }
            ctx.preparedNotice(prepared.notice);
            const resume =
              prepared.native.kind === "resume" ? prepared.native.sessionId : undefined;
            if (openingStarted && resume !== sessionIdentity)
              throw new Error(
                "Prepared context requires another native session. Reopen the source before dispatch.",
              );
            failureCode = "E-HUB-05";
            if (!openingStarted) sessionIdentity = resume;
            const session = await startOpening(resume);
            if (closed || ctx.isStopped()) return null;
            ctx.owedBytes.clear();
            ctx.handedOver();
            sendCalled = true;
            return session.send(id, prepared.prompt);
          })()
        : opening.then((session) => {
            if (closed) return null;
            const prepared = ctx.comparison.prepare(id, text);
            if (prepared.kind === "held") {
              if (!waiting.some((w) => w.id === id)) waiting.push({ id, text, mode });
              waiting.sort((a, b) => (arrival.get(a.id) ?? 0) - (arrival.get(b.id) ?? 0));
              return null;
            }
            if (prepared.kind === "ready") ctx.delivering();
            return session.send(id, prepared.kind === "ready" ? prepared.prompt : composed);
          });
    void delivery
      .then((sent) => {
        if (sent === null) return;
        if (sent.disposition === "rejected") {
          if (prepare && mode === "queue") {
            if (sent.rejectionEvidence)
              deps.onDispatchRejected?.(preparedTurnId, sent.rejectionEvidence);
            refusePrepared(new Error(sent.reason ?? "send rejected"), "E-HUB-05");
            return;
          }
          reject(id, sent.reason ?? "send rejected");
          return;
        }
        // Only `started` is left: `rejected` returned above, and hcn has
        // no third answer since ADR 0007 removed its queue. So a send that
        // was not refused opened a turn, and applied is the only truth to
        // record.
        ctx.expected.push({ inputId: id, applied: true });
        ctx.sequencer.disposition(id, "applied");
      })
      .catch((cause: unknown) => {
        if (prepare && mode === "queue") {
          if (!sendCalled) deps.onDispatchRejected?.(preparedTurnId, "dispatch-not-called");
          refusePrepared(cause, failureCode);
        } else reject(id, "session closed");
      });
  };

  const drainComparisonWaiting = (): void => {
    if (closed || turnRunning) return;
    const due = waiting.splice(0, waiting.length);
    for (const w of due) {
      if (ctx.comparison.eligible(w.id, w.text)) sendNow(w.id, w.text, w.mode);
      else waiting.push(w);
    }
  };
  return {
    recordChanged: drainComparisonWaiting,
    onInput(id: string, text: string, mode: InputMode): void {
      // Before a process exists, a steer starts work rather than interrupting
      // it, so it must pass the same preparation boundary as a queued input.
      if (deps.prepareTurn && !openingStarted && mode === "steer") mode = "queue";
      if (deps.prepareTurn && openingStarted && mode !== "queue") ctx.handedOver();
      if (received.has(id)) return;
      received.add(id);
      arrival.set(id, arrival.size);
      // A steer or answer is a request to interrupt/unblock, so it goes through mid-turn.
      // Everything else waits for the answer in progress to finish, which
      // is what the interactive path already does - the Stop hook fires at
      // a boundary, and the headless path now agrees with it.
      //
      // With no turn running there is no boundary coming, so holding the
      // input would be a hang rather than a policy.
      if (mode === "steer" || mode === "answer" || !turnRunning) {
        // RFC-12: an input about to reach an idle session crosses a turn
        // boundary, so the preference is honored before the hand-over. A
        // steer or an answer stays on the driver in force even while idle
        // (RFC-13 A8); an answer belongs to the driver that asked it.
        if (mode === "queue" && !closed && ctx.boundaryChange()) {
          endAsDriverChange();
          return;
        }
        sendNow(id, text, mode);
        return;
      }
      waiting.push({ id, text, mode });
    },
    turns: {
      async *[Symbol.asyncIterator]() {
        let session: Awaited<typeof opening>;
        try {
          session = await opening;
        } catch (cause) {
          if (closed) return;
          if (deps.prepareTurn) {
            refusePrepared(cause, "E-HUB-05");
            return;
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          // Record why before the pump detaches. This is the only place that
          // knows, and the log is the only thing the operator will have.
          ctx.sequencer.emit(ctx.getTurnId(), {
            kind: "error",
            message: `session did not open: ${message}`,
            terminal: true,
          });
          ctx.reported();
          // RFC-12: the spawn was refused (hcn exit 2, or the binary never
          // started). The owner decides whether a driver in force remains
          // to fall back to; the message names hcn's own refusal wording.
          ctx.openRefused(message);
          return;
        }
        for await (const turn of session.turns) {
          turnRunning = true;
          let boundaryReached = false;
          // Wrapped so the boundary is observed where it actually happens:
          // when this turn's events are exhausted. `finally` also covers a
          // consumer that abandons the turn early.
          const boundary = (): void => {
            if (boundaryReached) return;
            boundaryReached = true;
            turnRunning = false;
            if (closed) return;
            // RFC-12: the terminal event is the last moment to honor a
            // changed preference before the waiting inputs are handed over.
            // Ending here drops them back to the record - each is still
            // outstanding - and the replacement source replays them onto
            // the new spawn. A steer or an answer was never held, so none
            // is lost to this either.
            drainWaiting();
          };
          const bounded: AsyncIterable<HarnessEvent> = {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const event of turn) {
                  if (event.kind === EventKind.identity && typeof event.sessionId === "string")
                    sessionIdentity = event.sessionId;
                  yield event;
                  // The boundary is the terminal event, not the end of the
                  // stream. In session mode hcn holds a turn's stream open
                  // past its `done` - the next turn line closes it - so
                  // waiting for the iterator to finish waits for a turn that
                  // only a send would start, and the send is the thing being
                  // held. That deadlocked the second turn of every session
                  // conversation. The fake harness closes turns promptly, so
                  // only the live lanes caught it.
                  if (event.kind === EventKind.done) boundary();
                }
              } finally {
                // Backstop for a turn that ends without a terminal event: an
                // abandoned iterator, or a process that died mid-turn.
                // There is no safe boundary to dispatch queued work until
                // the pump settles this unacknowledged turn. Leave it in
                // the record for explicit recovery after source cleanup.
                if (!boundaryReached && deps.managed) turnRunning = false;
                else boundary();
              }
            },
          };
          // The pump matches a turn to the send that opened it by the id the
          // turn carries, so the wrapper has to carry it too. Copied rather
          // than re-derived: inventing one here would mis-attribute every
          // later disposition by one.
          Object.assign(bounded, {
            turnId: (turn as { turnId?: string }).turnId,
            inputId: (turn as { inputId?: string }).inputId,
          });
          yield bounded;
        }
      },
    },
    close(): Promise<void> {
      // Anything still waiting for a boundary is dropped here, not lost: it
      // has no applied disposition, so it is still outstanding in the record
      // and the next attach replays it.
      closed = true;
      waiting.length = 0;
      cancellation.abort();
      if (!openingStarted) deferred.reject(new Error("Source closed before prepared input"));
      return closeNative();
    },
  };
};

// ---------------------------------------------------------------------------
// Turn strategy — one process per turn, inputs queue between turns
// ---------------------------------------------------------------------------

const turnStrategy = (
  deps: HeadlessDeps & { readonly resume?: string },
  ctx: HostContext,
): StrategyHandle => {
  const queue: Array<{ id: string; text: string }> = [];
  let closed = false;
  // Seeded from the record, not just from this source's own first turn.
  // Holding it only in memory is why a restart used to start from nothing.
  let resumeId: string | undefined = deps.resume ?? ctx.resumeSessionId;
  let activeTurn: AsyncIterator<HarnessEvent> | null = null;
  let activeAbort: AbortController | null = null;
  let resolveWaiting: (() => void) | null = null;
  // RFC-12: whether the next spawn is this source's first, so the refusal
  // probe (see below) runs once, on the turn that proves the new spawn.
  let spawns = 0;
  let cleanup: Promise<void> | undefined;

  const wake = (): void => {
    const w = resolveWaiting;
    resolveWaiting = null;
    w?.();
  };

  /** Return the first payload read by the refusal probe, then stream the rest. */
  const composite = (
    head: readonly HarnessEvent[],
    tail: AsyncIterator<HarnessEvent>,
  ): AsyncIterable<HarnessEvent> => ({
    async *[Symbol.asyncIterator]() {
      try {
        for (const e of head) yield e;
        let step = await tail.next();
        while (!step.done) {
          yield step.value;
          step = await tail.next();
        }
      } finally {
        await tail.return?.();
      }
    },
  });

  // Turns generator — yields a turn iterable per queued input, in order.
  const turns: AsyncIterable<AsyncIterable<HarnessEvent>> = {
    [Symbol.asyncIterator](): AsyncIterator<AsyncIterable<HarnessEvent>> {
      return {
        async next(): Promise<IteratorResult<AsyncIterable<HarnessEvent>>> {
          while (!closed) {
            if (!queue.some((item) => ctx.comparison.eligible(item.id, item.text))) {
              await new Promise<void>((resolve) => {
                resolveWaiting = resolve;
              });
              if (closed)
                return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
            }
            const at = queue.findIndex((item) => ctx.comparison.eligible(item.id, item.text));
            if (at === -1) continue;
            const next = queue[at];
            if (next === undefined) continue;
            // RFC-12: the moment before the spawn is a turn boundary. A
            // changed preference ends this source instead of spawning: the
            // input is still queued-outstanding in the record, and the
            // replacement source's attach replays it onto the new spawn -
            // no input is lost to the switch.
            if (ctx.boundaryChange()) {
              ctx.driverChange();
              closed = true;
              wake();
              return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
            }
            const prepared = deps.prepareTurn
              ? { kind: "ordinary" as const }
              : ctx.comparison.prepare(next.id, next.text);
            if (prepared.kind === "held") continue;
            queue.splice(at, 1);
            if (prepared.kind === "ready") ctx.delivering();
            const turnId = ctx.getTurnId();
            // Disposition flips queued→applied at turn start — the host's
            // pump will have already shifted expected and dispatched;
            // this strategy's onInput already sent "queued", so we
            // disposition "applied" here to keep the same timing as the
            // original openHeadlessTurns drain loop.
            // Actually the host pump handles the shift; we reuse that:
            // but turnStrategy's queue shift happens here before Host
            // pump sees the turn. To avoid double-disposition, Host's
            // expected already holds the queued entry; Host pump will
            // shift it. We therefore do NOT disposition here — Host will.
            // Instead we just create the turn iterable and capture
            // resumeId on identity events via a wrapper.
            // Every later turn uses the latest emitted identity. A refusal
            // preserves the input for explicit recovery, never a fresh retry.
            activeAbort = new AbortController();
            let composedPrompt: string;
            if (deps.prepareTurn) {
              const prepared = await deps
                .prepareTurn({
                  inputId: next.id,
                  signal: activeAbort.signal,
                  text: next.text,
                  turnId,
                  profile: "headless-turn",
                  native:
                    resumeId === undefined
                      ? { kind: "fresh" }
                      : { kind: "resume", sessionId: resumeId },
                })
                .catch((cause: unknown) => {
                  if (classifyStoreFailure(cause) !== undefined || cause instanceof HubError)
                    throw cause;
                  throw new ContextPreparationError(
                    cause instanceof Error ? cause.message : String(cause),
                    { cause },
                  );
                });
              if (prepared.kind === "held") {
                const expected = ctx.expected.findIndex((input) => input.inputId === next.id);
                if (expected !== -1) ctx.expected.splice(expected, 1);
                continue;
              }
              composedPrompt = prepared.prompt;
              ctx.preparedNotice(prepared.notice);
              resumeId = prepared.native.kind === "resume" ? prepared.native.sessionId : undefined;
              ctx.owedBytes.clear();
            } else {
              composedPrompt =
                prepared.kind === "ready"
                  ? prepared.prompt
                  : composeAvailableState(
                      composeArtifactPrompt(composeAnnotationPrompt(next.text), "headless-turn"),
                      artifactState(deps, ctx),
                    );
            }
            const attemptResume = resumeId !== undefined;
            if (ctx.isStopped())
              return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
            await deps.beforeProcess?.(resumeId, activeAbort.signal);
            if (closed || ctx.isStopped())
              return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
            if (deps.prepareTurn) ctx.handedOver();
            let raw = deps.runner.streamTurn({
              signal: activeAbort.signal,
              ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
              harness: deps.harness,
              prompt: composedPrompt,
              turnId,
              ...(deps.model === undefined ? {} : { model: deps.model }),
              ...(deps.provider === undefined ? {} : { provider: deps.provider }),
              ...(deps.effort === undefined ? {} : { effort: deps.effort }),
              ...(attemptResume && resumeId !== undefined ? { resume: resumeId } : {}),
            });
            if (attemptResume || (deps.probeFirstTurn === true && spawns === 0)) {
              spawns += 1;
              const probe = raw[Symbol.asyncIterator]();
              activeTurn = probe;
              let step = await probe.next();
              // An identity announces the native process; it does not prove
              // the prompt ran. Record headers without buffering an answer.
              while (!step.done && step.value.kind === EventKind.identity) {
                const id = step.value.sessionId;
                if (typeof id === "string" && id !== "") resumeId = id;
                ctx.sequencer.emit(turnId, step.value);
                step = await probe.next();
              }
              const failure =
                !step.done && step.value.kind === EventKind.failure ? step.value : undefined;
              const failedEnd =
                !step.done && step.value.kind === EventKind.done && step.value.cause !== "clean";
              if (step.done || failure || failedEnd) {
                closed = true;
                if (!step.done) ctx.sequencer.emit(turnId, step.value);
                const detail =
                  typeof failure?.message === "string"
                    ? failure.message
                    : "No successful turn outcome was received";
                const message = `${detail}. The prompt and selected settings are preserved.`;
                ctx.sequencer.emit(turnId, {
                  kind: EventKind.error,
                  code: "E-HUB-05",
                  message,
                  terminal: true,
                });
                ctx.reported();
                ctx.openRefused(message);
                activeAbort.abort();
                await probe.return?.(undefined).catch(() => {});
                activeTurn = null;
                wake();
                return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
              }
              raw = composite([step.value], probe);
            }
            // Capture that this queued input's turn has started: if Host
            // hasn't yet disposed it, we need the waiter to be signaled.
            // Host's pump will shift expected; we already queued as
            // "queued" so the shift covers it — no extra disposition here.

            const wrapped: AsyncIterable<HarnessEvent> = {
              [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
                const it = raw[Symbol.asyncIterator]();
                activeTurn = it;
                return {
                  async next(): Promise<IteratorResult<HarnessEvent>> {
                    const step = await it.next();
                    if (!step.done && step.value.kind === "identity") {
                      const sid = (step.value as unknown as { sessionId: string }).sessionId;
                      if (typeof sid === "string") resumeId = sid;
                    }
                    if (step.done) activeTurn = null;
                    return step;
                  },
                  async return(value?: unknown): Promise<IteratorResult<HarnessEvent>> {
                    activeTurn = null;
                    const r = (it as AsyncIterator<HarnessEvent>).return;
                    if (r)
                      return r.call(it, value as never) as Promise<IteratorResult<HarnessEvent>>;
                    return { done: true, value: undefined as unknown as HarnessEvent };
                  },
                };
              },
            };

            Object.assign(wrapped, { inputId: next.id });
            return { done: false, value: wrapped };
          }
          return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
        },
      };
    },
  };

  const received = new Set<string>();
  return {
    recordChanged: wake,
    onInput(id: string, text: string, _mode: InputMode): void {
      if (received.has(id)) return;
      received.add(id);
      // Turn mode runs one process per turn, so every input already waits
      // for a boundary and there is nothing a steer could interrupt. The
      // reducer refuses `steer` on this profile with `steer-unsupported`
      // before it ever reaches here, so the mode is accepted and ignored.
      queue.push({ id, text });
      ctx.expected.push({ inputId: id, applied: false });
      ctx.sequencer.disposition(id, "queued");
      wake();
    },
    turns,
    close(): Promise<void> {
      closed = true;
      wake();
      activeAbort?.abort();
      cleanup ??= Promise.resolve().then(async () => {
        await activeTurn?.return?.(undefined);
      });
      return cleanup;
    },
  };
};

// ---------------------------------------------------------------------------
// Host factory — one lifecycle, strategy table
// ---------------------------------------------------------------------------

export const createHeadlessHost = (
  deps: HeadlessDeps & { readonly sessionId?: string; readonly resume?: string },
  profile: "headless-session" | "headless-turn",
): SourceChannel => {
  let stopped = false;
  let notified = false;
  let strategy: StrategyHandle | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let warningFailure: Extract<SourceEnd, { kind: "store-failed" }> | undefined;
  const notify = (end: SourceEnd): void => {
    if (!notified) {
      notified = true;
      deps.onEnded?.(end);
    }
  };
  const stop = (end: Extract<SourceEnd, { kind: "store-failed" }>): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    try {
      void strategy?.close().catch(() => {});
    } catch {}
    notify(end);
  };
  const send = deps.sendFrame;
  deps = {
    ...deps,
    sendFrame: (frame) => {
      if (stopped) return { verdict: "refused", issue: "source-stopped" };
      try {
        const result = send(frame);
        if (
          result.verdict === "refused" &&
          (warningFailure !== undefined || frame.kind === "detach")
        ) {
          stop(
            warningFailure ?? {
              kind: "store-failed",
              code: "record-write-failed",
              operation: "detach",
            },
          );
        }
        return result;
      } catch (cause) {
        stop(
          warningFailure ?? {
            kind: "store-failed",
            code: classifyStoreFailure(cause) ?? "record-write-failed",
            operation: frame.kind,
          },
        );
        return { verdict: "refused", issue: "source-stopped" };
      }
    },
  };
  const sequencer = createSequencer(deps, profile);
  let recoveryReplay: readonly Frame[] = [];
  try {
    recoveryReplay = deps.onAttached?.() ?? [];
  } catch (cause) {
    sequencer.detachOnce("shutdown");
    throw cause;
  }
  let currentTurnId = deps.mintTurnId();
  const expected: Array<{ inputId: string; applied: boolean }> = [];

  // The pump ending IS the session ending: the turn stream completing means
  // the harness has no more turns to give. Both outcomes were swallowed —
  // the rejection by an empty catch, the clean end by saying nothing — and
  // what a person saw was a driver still holding the presence lock, already
  // detached, with nothing in the record to say why. Nothing else could take
  // over, and nothing said anything was wrong.
  let ended = false;
  // RFC-12: how this source ended, for its owner. Set by the strategies
  // through ctx (driver-change, open-refused) or left as a plain close;
  // read once by the pump's end, after the strategies are done deciding.
  let sourceEnd: SourceEnd = { kind: "closed" };
  let sourceEndSet = false;
  const setSourceEnd = (end: SourceEnd): void => {
    if (sourceEndSet) return;
    sourceEndSet = true;
    sourceEnd = end;
  };

  const ctx: HostContext = {
    preparedNotice: (message) => {
      if (message)
        sequencer.emit(currentTurnId, {
          kind: EventKind.error,
          code: "context-summarized",
          message,
          terminal: false,
        });
    },
    handedOver: () => {
      handedOverAt = clock();
      stallReported = false;
    },
    isStopped: () => stopped,
    stop,
    warning: (event, operation, artifactId) => {
      warningFailure = { kind: "store-failed", code: "record-busy", operation, artifactId };
      try {
        sequencer.emit(currentTurnId, event);
      } catch {
        stop(warningFailure);
      } finally {
        warningFailure = undefined;
      }
    },
    sequencer,
    reported: () => {
      ended = true;
    },
    ...(sequencer.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: sequencer.resumeSessionId }),
    getTurnId: () => currentTurnId,
    nextTurnId: () => {
      currentTurnId = deps.mintTurnId();
      return currentTurnId;
    },
    expected,
    owedBytes: new Set<string>(),
    comparison: createComparisonDelivery({
      capable: true,
      snapshot: deps.host.comparisonSnapshot,
      head: (id) => deps.host.artifactHeads().get(id),
      hold: (event) => {
        if (deps.host.inputStatus?.(event.inputId) !== "queued")
          sequencer.disposition(event.inputId, "queued");
        sequencer.emit(currentTurnId, event);
      },
    }),
    delivering: () => {
      handedOverAt = clock();
      stallReported = false;
    },
    boundaryChange: () => deps.driverChangeAtBoundary?.() ?? false,
    driverChange: () => setSourceEnd({ kind: "driver-change" }),
    openRefused: (message: string) => setSourceEnd({ kind: "open-refused", message }),
  };

  // Record the mode notice before replay can produce an answer.
  for (const note of deps.notes ?? []) {
    ctx.sequencer.emit(ctx.getTurnId(), {
      kind: EventKind.error,
      message: note,
      terminal: false,
    });
  }

  // The stall watchdog.
  //
  // lucid hands an input to the harness and the harness answers with a
  // disposition and a turn. When it answers with nothing, there was nothing
  // in the record to say so: no event, no error, no entry at all between
  // one input and the next. A person watching saw a conversation that had
  // simply stopped, with no way to tell it from one that was thinking.
  //
  // This does not cancel anything and does not retry. The input stays
  // delivered, the harness keeps whatever it has, and a late answer lands
  // normally. It writes down that the silence happened, once per stall, so
  // the terminal, the browser and the log all say the same thing.
  const clock = deps.now ?? (() => Date.now());
  const stallAfter = deps.stallMs ?? STALL_MS;
  let handedOverAt: number | null = null;
  let stallReported = false;

  /** Anything the harness says clears the watch — it is answering. */
  const harnessSpoke = (): void => {
    handedOverAt = null;
    stallReported = false;
  };

  watchdog = setInterval(() => {
    if (handedOverAt === null || stallReported) return;
    if (clock() - handedOverAt < stallAfter) return;
    stallReported = true;
    ctx.sequencer.emit(ctx.getTurnId(), {
      kind: EventKind.error,
      message: `the harness has not answered for ${Math.round((clock() - handedOverAt) / 1000)}s since an input was handed to it; it may be wedged`,
      terminal: false,
    });
  }, deps.stallTickMs ?? 5_000);
  // Nothing here should hold the process open on its own.
  (watchdog as unknown as { unref?: () => void }).unref?.();

  strategy =
    profile === "headless-session"
      ? sessionStrategy(deps as HeadlessDeps & { sessionId: string }, ctx)
      : turnStrategy(deps as HeadlessDeps & { resume?: string }, ctx);

  // Pump — one place that flips a queued input to applied when its turn
  // starts, emits events under the current turnId, and detaches once.
  //
  // The match is by the id the turn carries, not by position. A positional
  // shift assumed the disposition was recorded before the turn arrived, and
  // once the disposition became hcn's answer over a pipe that ordering was
  // no longer lucid's to guarantee: a lost race would have mis-attributed
  // every later disposition by one. The runner tags each turn with the send
  // that opened it precisely so this does not have to be inferred.
  const pump = (async () => {
    for await (const turn of strategy.turns) {
      const turnId = currentTurnId;
      let advanced = false;
      const inputId = (turn as { inputId?: string }).inputId;
      const at =
        inputId === undefined
          ? expected.length > 0
            ? 0
            : -1
          : expected.findIndex((e) => e.inputId === inputId);
      if (at !== -1) {
        const exp = expected.splice(at, 1)[0];
        if (exp !== undefined && !exp.applied) {
          sequencer.disposition(exp.inputId, "applied", "queued turn started");
        }
      }
      for await (const event of turn) {
        if (stopped) return;
        // RFC-06 Emission: parse artifact fences out of message events and
        // store versions. Malformed/oversize/stale are refused with reason
        // recorded, turn still completes.
        if (
          event.kind === EventKind.message &&
          typeof (event as { text?: unknown }).text === "string"
        ) {
          handleArtifactMessage((event as { text: string }).text, turnId, deps, ctx);
        }
        if (stopped) return;
        // The harness said something, so it is answering. Every event goes
        // through here, which is why the watch is cleared here rather than
        // at each of the places one can be produced.
        harnessSpoke();
        sequencer.emit(turnId, event);
        if (event.kind === EventKind.done && !advanced) {
          // A persistent session keeps this iterator open until the next
          // turn arrives. Its terminal acknowledgement is the boundary.
          if (profile === "headless-session") deps.onTurnSettled?.(turnId);
          currentTurnId = deps.mintTurnId();
          advanced = true;
        }
      }
      deps.onTurnSettled?.(turnId);
      if (!advanced) currentTurnId = deps.mintTurnId();
    }
  })();
  const sessionEnded = (why: string): void => {
    if (ended || stopped) return;
    ended = true;
    try {
      ctx.sequencer.emit(ctx.getTurnId(), {
        kind: EventKind.error,
        message: `the harness session ended (${why}); this driver is no longer answering`,
        terminal: false,
      });
    } catch {
      // Emitting is best effort. If the channel is already gone, the detach
      // below is still the right thing to do.
    }
  };
  const settled = pump
    .then(() => {
      // RFC-12: a driver change is a hand-off, not a death - the successor
      // source continues the conversation, and the record already carries
      // the story (the new attach). Reporting a session end here would
      // make every honored switch read as a harness failure.
      if (!ended && sourceEnd.kind !== "driver-change")
        sessionEnded("the harness closed its turn stream");
    })
    .catch((cause: unknown) => {
      const code = classifyStoreFailure(cause);
      if (code !== undefined) {
        stop({
          kind: "store-failed",
          code,
          operation: "turn",
        });
        return;
      }
      if (
        cause instanceof HubError ||
        cause instanceof ContextPreparationError ||
        cause instanceof ExecutionSettlementError
      ) {
        ctx.sequencer.emit(ctx.getTurnId(), {
          kind: EventKind.error,
          code: cause.code,
          message: cause.message,
          terminal: true,
        });
        ctx.reported();
        ctx.openRefused(cause.message);
        return;
      }
      // RFC-12: a spawn that never started (the hcn binary itself) is an
      // open refusal for the owner's purposes: hcn's own invocation
      // refusals are already carried by the strategies; this is the case
      // where `deps.spawn` threw and no stream ever existed.
      if (cause instanceof HarnessSpawnError) ctx.openRefused(cause.message);
      sessionEnded(cause instanceof Error ? cause.message : String(cause));
    })
    .finally(async () => {
      // The stall watchdog watches a live hand-over; with the pump gone
      // there is no hand-over left to watch, and a late fire would emit
      // through a detached sequencer - a fatal refusal thrown from a
      // timer, which nothing catches. This is not theoretical: every
      // honored driver change ends a source with an input in hand (the
      // one that triggered it), and that input is exactly what the
      // watchdog would later report as silence.
      clearInterval(watchdog);
      try {
        await strategy?.close();
      } finally {
        if (!stopped) {
          try {
            sequencer.detachOnce(sourceEnd.kind === "driver-change" ? "yield" : "shutdown");
          } finally {
            if (!stopped) notify(sourceEnd);
          }
        }
      }
    });

  void settled.catch(() => {});

  const receive = (frame: Frame): void => {
    if (stopped) return;
    switch (frame.kind) {
      case "input":
        if (!deps.prepareTurn) ctx.handedOver();
        // The mode travels with the input all the way to the strategy. It
        // used to stop here, which made `steer` and `queue` mean the same
        // thing to a harness.
        strategy?.onInput(frame.id, frame.text, frame.mode);
        return;
      case "credit":
        sequencer.onCredit(frame.tokens);
        return;
      default:
        return;
    }
  };

  // Inputs the record was already holding, delivered through the same path
  // as a live one.
  //
  // Attach replays every input still awaiting an applied disposition - that
  // is what makes `lucid send` while nothing is attached mean anything. The
  // sequencer captured them off the attach result, because at that instant
  // the host's effect sink is not wired yet: the source attaches while it is
  // being constructed, so an effect emitted then has nowhere to go. Nothing
  // read them back. A record with a pending input would attach, hold it, and
  // sit there: no turn, no reply, nothing in the log after the attach line.
  //
  // Drained here because this is the first moment `strategy` exists. Same
  // idempotent input id, so a replay that races a live delivery applies once.
  //
  // RFC-04 R3: the cursor records how far dispatch has got, and it is
  // written AFTER the dispatch it covers, never before. A crash in the gap
  // repeats the batch, which is the at-least-once window; advancing first
  // would lose it, which is the inverse of the guarantee.
  //
  // Delivery itself stays with attachReplay, which is the reducer's set of
  // inputs still awaiting an applied disposition. Dispatching the collected
  // batch instead would redeliver every input in the record, applied ones
  // included: a record with no cursor starts at offset 0, so a conversation
  // written before cursors existed would re-send its whole history to the
  // harness on the next open. Proven against a record with one applied
  // input - the batch offered it, attachReplay correctly did not.
  //
  // Offset dedup is the store's, tested there, and comes into its own in the
  // tailing work, where effects arrive that attachReplay cannot see because
  // another process appended them.
  try {
    const replay = [...sequencer.attachReplay, ...recoveryReplay];
    const inputs = replay
      .filter((frame): frame is Extract<Frame, { kind: "input" }> => frame.kind === "input")
      .sort((a, b) => a.seq - b.seq);
    for (const frame of replay) if (frame.kind !== "input") receive(frame);
    for (const frame of inputs) receive(frame);
  } catch (cause) {
    stop({
      kind: "store-failed",
      code: classifyStoreFailure(cause) ?? "record-write-failed",
      operation: "replay",
    });
  }
  if (!stopped) {
    const cur = deps.host.cursor();
    const batch = deps.host.collectEffects(cur);
    if (batch.goodBytes > cur) deps.host.advanceCursor(batch.goodBytes);
  }

  return {
    receive,
    settled,
    recordChanged: () => {
      if (!stopped) strategy?.recordChanged();
    },
    close: (): void => {
      if (stopped) return;
      clearInterval(watchdog);
      try {
        sequencer.detachOnce("shutdown");
      } finally {
        if (!stopped) {
          stopped = true;
          try {
            void strategy?.close().catch(() => {});
          } catch {}
          notify({ kind: "closed" });
        }
      }
    },
  };
};

/** Mode 2: one persistent process serves many turns. Thin adapter over Host. */
export const openHeadlessSession = (
  deps: Parameters<typeof createHeadlessHost>[0] & { readonly sessionId: string },
): ReturnType<typeof createHeadlessHost> => createHeadlessHost(deps, "headless-session");

/** Mode 1: one process per turn. Thin adapter over Host. */
export const openHeadlessTurns = (
  deps: Parameters<typeof createHeadlessHost>[0] & { readonly resume?: string },
): ReturnType<typeof createHeadlessHost> => createHeadlessHost(deps, "headless-turn");
