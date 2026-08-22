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
import type { Frame, ReduceResult } from "../protocol/index.js";
import { createSequencer } from "./sequencer.js";

/** What sendFrame returns. */
type SendResult = ReduceResult | { readonly verdict: "refused"; readonly issue: string };

export interface HeadlessDeps {
  readonly harness: HarnessName;
  readonly conversationId: string;
  readonly secret: string;
  readonly runner: HarnessRunner;
  /** Lucid mints headless turnIds (PLAN 4.3); injected for determinism. */
  readonly mintTurnId: () => string;
  /** The in-process channel to the host. */
  readonly sendFrame: (frame: Frame) => SendResult;
}

export interface SourceChannel {
  /** Host -> source frames (input, control, credit, lease, event-ack). */
  readonly receive: (frame: Frame) => void;
  readonly close: () => void;
}

export { HeadlessError } from "./sequencer.js";

// ---------------------------------------------------------------------------
// Shared host context — sequencer + turnId + expected FIFO owned once
// ---------------------------------------------------------------------------

interface HostContext {
  readonly sequencer: ReturnType<typeof createSequencer>;
  getTurnId(): string;
  nextTurnId(): string;
  readonly expected: Array<{ inputId: string; applied: boolean }>;
}

interface StrategyHandle {
  /** Handle an input arrival — must disposition via sequencer and arrange
   *  the prompt for the runner (send now vs queue). */
  onInput(id: string, text: string): void;
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
  });
  // A failure to open must not become an unhandled rejection; the pump
  // surfaces it by ending the turn stream.
  opening.catch(() => {});

  return {
    onInput(id: string, text: string): void {
      // hcn answers a send with exactly one disposition, and it answers
      // before it opens the turn. So the reply is awaited and recorded when
      // it lands: one disposition per input, the same as before, just no
      // longer decided locally.
      void opening
        .then((session) => session.send(id, text))
        .then((sent) => {
          if (sent.disposition === "rejected") {
            ctx.sequencer.disposition(id, "rejected", sent.reason ?? "send rejected");
            return;
          }
          const started = sent.disposition === "started";
          ctx.expected.push({ inputId: id, applied: started });
          ctx.sequencer.disposition(id, started ? "applied" : "queued");
        })
        .catch(() => {
          ctx.sequencer.disposition(id, "rejected", "session closed");
        });
    },
    turns: {
      async *[Symbol.asyncIterator]() {
        let session: Awaited<typeof opening>;
        try {
          session = await opening;
        } catch {
          return; // the session never opened; the pump detaches
        }
        for await (const turn of session.turns) yield turn;
      },
    },
    close(): void {
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
  let resumeId: string | undefined = deps.resume;
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
            const raw = deps.runner.streamTurn({
              harness: deps.harness,
              prompt: next.text,
              turnId,
              ...(resumeId === undefined ? {} : { resume: resumeId }),
            });
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
    onInput(id: string, text: string): void {
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

  const ctx: HostContext = {
    sequencer,
    getTurnId: () => currentTurnId,
    nextTurnId: () => {
      currentTurnId = deps.mintTurnId();
      return currentTurnId;
    },
    expected,
  };

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
        sequencer.emit(currentTurnId, event);
      }
      currentTurnId = deps.mintTurnId();
    }
  })();
  pump
    .catch(() => {})
    .finally(() => {
      sequencer.detachOnce("shutdown");
    });

  return {
    receive: (frame: Frame): void => {
      switch (frame.kind) {
        case "input":
          strategy.onInput(frame.id, frame.text);
          return;
        case "credit":
          sequencer.onCredit(frame.tokens);
          return;
        default:
          return;
      }
    },
    close: (): void => {
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
