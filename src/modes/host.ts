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
import type { HarnessName, HarnessRunner } from "../harness/runner.js";
import { composeAnnotationPrompt } from "../protocol/annotations.js";
import {
  ARTIFACT_PREAMBLE_MARKER,
  type ArtifactState,
  composeArtifactPrompt,
  composeArtifactState,
  detectArtifactBlocks,
} from "../protocol/artifacts.js";
import { EventKind } from "../protocol/events.js";
import type { Frame, InputMode, ReduceResult } from "../protocol/index.js";
import { applyPatch, parsePatchBody } from "../protocol/patch.js";
import type { CollectedBatch } from "../store/log.js";
import { ARTIFACT_BYTES_MAX } from "../store/log.js";
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

/** What the record currently holds, read fresh so a save made a second ago
 * is in it. Headers only — the document bytes are read to get at the author
 * and the values and are not kept. */
const artifactState = (deps: HeadlessDeps): readonly ArtifactState[] => {
  const index = deps.host?.artifactIndex?.();
  if (index === undefined || deps.host?.readArtifact === undefined) return [];
  const current = new Map<string, number>();
  for (const key of index.keys()) {
    const sep = key.indexOf("\0");
    if (sep === -1) continue;
    const id = key.slice(0, sep);
    const v = Number(key.slice(sep + 1));
    if (!Number.isSafeInteger(v)) continue;
    if ((current.get(id) ?? 0) < v) current.set(id, v);
  }
  const out: ArtifactState[] = [];
  for (const [artifactId, version] of [...current.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const one = deps.host.readArtifact(artifactId, version);
    if (one === null) continue;
    out.push({
      artifactId,
      version,
      author: one.author,
      ...(one.basedOn === undefined ? {} : { basedOn: one.basedOn }),
      ...(one.values === undefined ? {} : { values: one.values }),
      // Only for a version a person saved. The agent wrote its own versions
      // and does not need them read back; the person's is the one it has
      // never seen, and the one it will otherwise revise away.
      ...(one.author === "human" ? { bytes: one.bytes } : {}),
    });
  }
  return out;
};

/** What sendFrame returns. */
type SendResult = ReduceResult | { readonly verdict: "refused"; readonly issue: string };

export interface HeadlessDeps {
  readonly harness: HarnessName;
  readonly conversationId: string;
  readonly secret: string;
  readonly runner: HarnessRunner;
  /** Routing, passed through to hcn: a model within the harness, and a
   * provider for the harnesses that express one (pi). Absent means the
   * harness's own default. */
  readonly model?: string;
  readonly provider?: string;
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
  /** The record, for delivery-cursor bookkeeping (RFC-04 R3). When present
   * the host advances the cursor after the attach drain. Optional only
   * because in-process tests build a source without one; delivery does not
   * depend on it, so its absence changes nothing that is dispatched. */
  readonly host?: {
    cursor(): number;
    collectEffects(fromOffset: number): CollectedBatch;
    advanceCursor(offset: number): void;
    artifactIndex?: () => ReadonlyMap<string, number>;
    /** Read one version's header — author, basedOn, values — so the prompt
     * can say what the record currently holds. */
    readArtifact?: (
      artifactId: string,
      version: number,
    ) => {
      readonly author: string;
      readonly basedOn?: number;
      readonly values?: Readonly<Record<string, string>>;
      /** Needed for a version a person saved: it is the one the agent has
       * never seen, and would otherwise revise away. */
      readonly bytes?: string;
    } | null;
    writeArtifact?: (params: {
      readonly artifactId: string;
      readonly version: number;
      readonly author: string;
      readonly contentType: string;
      readonly bytes: string;
    }) => { verdict: "accepted"; version: unknown } | { verdict: "refused"; issue: string };
  };
}

export interface SourceChannel {
  /** Host -> source frames (input, control, credit, lease, event-ack). */
  readonly receive: (frame: Frame) => void;
  readonly close: () => void;
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
    if (
      deps.host === undefined ||
      deps.host.artifactIndex === undefined ||
      deps.host.writeArtifact === undefined
    ) {
      // No durable host to write to — still report that we saw it, but
      // cannot store. This path is exercised in in-process tests that
      // build a source without a host; production always has one.
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact ${header.id} not stored: no host`,
        terminal: false,
      });
      continue;
    }
    // Determine current version for this id — max of durable index and
    // local assignments within this message.
    let current = 0;
    const idx = deps.host.artifactIndex?.() ?? new Map<string, number>();
    for (const [key] of idx) {
      const sep = key.indexOf("\0");
      if (sep === -1) continue;
      const id = key.slice(0, sep);
      if (id === header.id) {
        const v = Number(key.slice(sep + 1));
        if (Number.isSafeInteger(v) && v > current) current = v;
      }
    }
    const local = localVersions.get(header.id);
    if (local !== undefined && local > current) current = local;

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
      const res = deps.host.writeArtifact?.({
        artifactId: header.id,
        version: 1,
        author: "agent",
        contentType: header.contentType,
        bytes,
      });
      if (res?.verdict === "accepted") {
        localVersions.set(header.id, 1);
      } else {
        ctx.sequencer.emit(turnId, {
          kind: EventKind.error,
          message: `artifact ${header.id} not stored: ${res?.issue ?? "no host"}`,
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
      const base = deps.host.readArtifact?.(header.id, current);
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
    if (res?.verdict === "accepted") {
      localVersions.set(header.id, next);
    } else {
      ctx.sequencer.emit(turnId, {
        kind: EventKind.error,
        message: `artifact ${header.id} v${next} not stored: ${res?.issue ?? "no host"}`,
        terminal: false,
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Shared host context — sequencer + turnId + expected FIFO owned once
// ---------------------------------------------------------------------------

interface HostContext {
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
}

interface StrategyHandle {
  /** Handle an input arrival — must disposition via sequencer and arrange
   *  the prompt for the runner (send now vs queue). `mode` decides whether
   *  a mid-turn arrival interrupts: `steer` goes through at once, `queue`
   *  waits for the boundary. */
  onInput(id: string, text: string, mode: InputMode): void;
  /** Async iterable of turns, each turn iterable of HarnessEvents. The host
   *  pumps this, shifting expected at each boundary and emitting events
   *  under the current turnId. */
  readonly turns: AsyncIterable<AsyncIterable<HarnessEvent>>;
  close(): void;
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
  const opening = deps.runner.openSession({
    harness: deps.harness,
    sessionId: deps.sessionId,
    // Continue the session this harness last held in this record, if lucid
    // found one. The id comes from attach-ok and nowhere else.
    ...(ctx.resumeSessionId === undefined ? {} : { resume: ctx.resumeSessionId }),
    ...(deps.model === undefined ? {} : { model: deps.model }),
    ...(deps.provider === undefined ? {} : { provider: deps.provider }),
  });
  // A failure to open must not become an unhandled rejection. It must also
  // not be silent: a session hcn refuses (a harness with no session mode, an
  // unknown model, a provider it cannot express) ends the source exactly like
  // a clean shutdown, so without a record the durable log cannot tell a
  // refusal from a crash. Found by running the seam against codex, which has
  // no session mode: lucid detached correctly and said nothing.
  opening.catch(() => {});

  // Whether a turn is running right now. Set when the pump takes a turn off
  // the session and cleared when that turn's events end - the boundary is an
  // event the pump already sees, so nothing here polls for it.
  let turnRunning = false;
  let closed = false;
  // Inputs that arrived mid-turn in `queue` mode, waiting for the boundary. Answers and steers are never held (RFC-05 R3).
  const waiting: Array<{ id: string; text: string; mode: InputMode }> = [];

  let artifactPreambleSent = false;
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
    if (mode !== "answer") {
      let framed = composeAnnotationPrompt(text);
      if (!artifactPreambleSent) {
        const withProtocol = composeArtifactPrompt(framed, "headless-session");
        if (withProtocol !== framed || text.startsWith(ARTIFACT_PREAMBLE_MARKER)) {
          artifactPreambleSent = true;
        }
        framed = withProtocol;
      }
      composed = composeArtifactState(framed, artifactState(deps));
    }
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
              message: `answer demoted: no-open-question for ${id}`,
              terminal: false,
            });
            return opening
              .then((session) => session.send(id, text))
              .then((sent) => {
                if (sent.disposition === "rejected") {
                  ctx.sequencer.disposition(id, "rejected", sent.reason ?? "send rejected");
                  return;
                }
                ctx.expected.push({ inputId: id, applied: true });
                ctx.sequencer.disposition(id, "applied");
              })
              .catch(() => {
                ctx.sequencer.disposition(id, "rejected", "session closed");
              });
          }
          if (ans.disposition === "rejected") {
            ctx.sequencer.disposition(id, "rejected", ans.reason ?? "answer rejected");
            return;
          }
          ctx.expected.push({ inputId: id, applied: true });
          ctx.sequencer.disposition(id, "applied");
        })
        .catch(() => {
          ctx.sequencer.disposition(id, "rejected", "session closed");
        });
      return;
    }
    void opening
      .then((session) => session.send(id, composed))
      .then((sent) => {
        if (sent.disposition === "rejected") {
          ctx.sequencer.disposition(id, "rejected", sent.reason ?? "send rejected");
          return;
        }
        // Only `started` is left: `rejected` returned above, and hcn has
        // no third answer since ADR 0007 removed its queue. So a send that
        // was not refused opened a turn, and applied is the only truth to
        // record.
        ctx.expected.push({ inputId: id, applied: true });
        ctx.sequencer.disposition(id, "applied");
      })
      .catch(() => {
        ctx.sequencer.disposition(id, "rejected", "session closed");
      });
  };

  return {
    onInput(id: string, text: string, mode: InputMode): void {
      // A steer or answer is a request to interrupt/unblock, so it goes through mid-turn.
      // Everything else waits for the answer in progress to finish, which
      // is what the interactive path already does - the Stop hook fires at
      // a boundary, and the headless path now agrees with it.
      //
      // With no turn running there is no boundary coming, so holding the
      // input would be a hang rather than a policy.
      if (mode === "steer" || mode === "answer" || !turnRunning) {
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
          // Record why before the pump detaches. This is the only place that
          // knows, and the log is the only thing the operator will have.
          ctx.sequencer.emit(ctx.getTurnId(), {
            kind: "error",
            message: `session did not open: ${cause instanceof Error ? cause.message : String(cause)}`,
            terminal: true,
          });
          ctx.reported();
          return;
        }
        for await (const turn of session.turns) {
          turnRunning = true;
          // Wrapped so the boundary is observed where it actually happens:
          // when this turn's events are exhausted. `finally` also covers a
          // consumer that abandons the turn early.
          const boundary = (): void => {
            if (!turnRunning) return;
            turnRunning = false;
            if (closed) return;
            const due = waiting.splice(0, waiting.length);
            for (const w of due) sendNow(w.id, w.text, w.mode);
          };
          const bounded: AsyncIterable<HarnessEvent> = {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const event of turn) {
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
                boundary();
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
    close(): void {
      // Anything still waiting for a boundary is dropped here, not lost: it
      // has no applied disposition, so it is still outstanding in the record
      // and the next attach replays it.
      closed = true;
      waiting.length = 0;
      void opening.then((session) => session.close()).catch(() => {});
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
  // A resume hint is tried at most once. A second attempt would re-refuse.
  let resumeTried = false;
  let activeTurn: AsyncIterator<HarnessEvent> | null = null;
  let resolveWaiting: (() => void) | null = null;

  const wake = (): void => {
    const w = resolveWaiting;
    resolveWaiting = null;
    w?.();
  };

  // Turns generator — yields a turn iterable per queued input, in order.
  const turns: AsyncIterable<AsyncIterable<HarnessEvent>> = {
    [Symbol.asyncIterator](): AsyncIterator<AsyncIterable<HarnessEvent>> {
      return {
        async next(): Promise<IteratorResult<AsyncIterable<HarnessEvent>>> {
          while (!closed) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                resolveWaiting = resolve;
              });
              if (closed)
                return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
            }
            const next = queue.shift();
            if (next === undefined) continue;
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
            // RFC-03 R002: a resume id read out of the record is a HINT. The
            // harness may no longer have that session - hcn refuses an
            // unknown id before spawn, which is a refusal, not an outage.
            // Try it once, and if it is refused run the same input fresh
            // rather than losing the turn to a stale id.
            const attemptResume = resumeId !== undefined && !resumeTried;
            if (attemptResume) resumeTried = true;
            const composedPrompt = composeArtifactState(
              composeArtifactPrompt(composeAnnotationPrompt(next.text), "headless-turn"),
              artifactState(deps),
            );
            let raw = deps.runner.streamTurn({
              harness: deps.harness,
              prompt: composedPrompt,
              turnId,
              ...(deps.model === undefined ? {} : { model: deps.model }),
              ...(attemptResume && resumeId !== undefined ? { resume: resumeId } : {}),
            });
            if (attemptResume) {
              const buffered: HarnessEvent[] = [];
              let refusedResume = false;
              for await (const e of raw) {
                buffered.push(e);
                if (e.kind === "failure" && (e as { class?: string }).class === "rejected") {
                  refusedResume = true;
                }
              }
              if (refusedResume) {
                // The stale id is not this conversation's problem any more.
                const staleId = resumeId;
                resumeId = undefined;
                ctx.sequencer.emit(turnId, {
                  kind: "error",
                  message: `could not resume harness session ${staleId}; continuing fresh`,
                });
                const retryPrompt = composeArtifactState(
                  composeArtifactPrompt(composeAnnotationPrompt(next.text), "headless-turn"),
                  artifactState(deps),
                );
                raw = deps.runner.streamTurn({
                  harness: deps.harness,
                  prompt: retryPrompt,
                  turnId,
                  ...(deps.model === undefined ? {} : { model: deps.model }),
                });
              } else {
                // It worked: replay what was read while deciding.
                raw = {
                  async *[Symbol.asyncIterator]() {
                    for (const e of buffered) yield e;
                  },
                };
              }
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

            // Record that this turn consumes a queued input — Host's
            // expected already has it as queued=false, but turn mode's
            // queue has been shifted above; we keep them in sync by
            // noting resumeId continuity happens above.
            void next;
            return { done: false, value: wrapped };
          }
          return { done: true, value: undefined as unknown as AsyncIterable<HarnessEvent> };
        },
      };
    },
  };

  return {
    onInput(id: string, text: string, _mode: InputMode): void {
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
    close(): void {
      closed = true;
      wake();
      void activeTurn?.return?.(undefined);
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
  const sequencer = createSequencer(deps, profile);
  let currentTurnId = deps.mintTurnId();
  const expected: Array<{ inputId: string; applied: boolean }> = [];

  // The pump ending IS the session ending: the turn stream completing means
  // the harness has no more turns to give. Both outcomes were swallowed —
  // the rejection by an empty catch, the clean end by saying nothing — and
  // what a person saw was a driver still holding the presence lock, already
  // detached, with nothing in the record to say why. Nothing else could take
  // over, and nothing said anything was wrong.
  let ended = false;

  const ctx: HostContext = {
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
  };

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

  const watchdog = setInterval(() => {
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

  const strategy: StrategyHandle =
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
        // RFC-06 Emission: parse artifact fences out of message events and
        // store versions. Malformed/oversize/stale are refused with reason
        // recorded, turn still completes.
        if (
          event.kind === EventKind.message &&
          typeof (event as { text?: unknown }).text === "string"
        ) {
          handleArtifactMessage((event as { text: string }).text, currentTurnId, deps, ctx);
        }
        // The harness said something, so it is answering. Every event goes
        // through here, which is why the watch is cleared here rather than
        // at each of the places one can be produced.
        harnessSpoke();
        sequencer.emit(currentTurnId, event);
      }
      currentTurnId = deps.mintTurnId();
    }
  })();
  const sessionEnded = (why: string): void => {
    if (ended) return;
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
  pump
    .then(() => sessionEnded("the harness closed its turn stream"))
    .catch((cause: unknown) => {
      sessionEnded(cause instanceof Error ? cause.message : String(cause));
    })
    .finally(() => {
      sequencer.detachOnce("shutdown");
    });

  const receive = (frame: Frame): void => {
    switch (frame.kind) {
      case "input":
        handedOverAt = clock();
        stallReported = false;
        // The mode travels with the input all the way to the strategy. It
        // used to stop here, which made `steer` and `queue` mean the same
        // thing to a harness.
        strategy.onInput(frame.id, frame.text, frame.mode);
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
  for (const frame of sequencer.attachReplay) receive(frame);
  if (deps.host !== undefined) {
    const cur = deps.host.cursor();
    const batch = deps.host.collectEffects(cur);
    if (batch.goodBytes > cur) deps.host.advanceCursor(batch.goodBytes);
  }

  return {
    receive,
    close: (): void => {
      clearInterval(watchdog);
      sequencer.detachOnce("shutdown");
      try {
        strategy.close();
      } catch {}
    },
  };
};

// Compat wrappers — preserve the existing openHeadlessSession / Turns
// surface so tests and callers that import from headless.ts keep working
// while the host is the single owner. These are thin adapters over the
// same strategy table; the deletion test passes: deleting this file would
// require moving the strategy table back into two places.

export const openHeadlessSessionViaHost = (
  deps: HeadlessDeps & { readonly sessionId: string },
): SourceChannel => createHeadlessHost(deps, "headless-session");

export const openHeadlessTurnsViaHost = (
  deps: HeadlessDeps & { readonly resume?: string },
): SourceChannel => createHeadlessHost(deps, "headless-turn");
