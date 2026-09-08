/**
 * TurnSequencer — the deep module that owns the headless transactional
 * credit spine.
 *
 * `src/modes/headless.ts` previously owned three things in one file:
 * the attach handshake, the per-epoch `n` + credit-balance +
 * `pending: PendingDroppable<HarnessEvent>[]` discipline, and two turn
 * lifecycles (`openHeadlessSession` vs `openHeadlessTurns`) with their
 * own FIFO shapes (`expectedTurns` vs `queue + resumeId`). The
 * hard invariant — transactional `n` (committed only on `accepted`,
 * requeued on `no-credit`), `pending` stays owned by the turn that
 * produced it, a turn's lossless event supersedes its stale deltas
 * (`protocol/events.ts` owns that policy), and `detachOnce` fires once —
 * was smeared across the modes: fixing a starvation edge fixed only one
 * adapter, and adding a third mode would be a third copy.
 *
 * Now one module owns the whole discipline. The headless adapters become
 * thin translators over the same interface: the harness `Runner` and the
 * input arrival (session: `send` now, turn: queue) differ, the sequencer
 * does not. The deletion test passes: deleting this module would scatter
 * `n` + balance + `pending` + `detachOnce` + `coalesce/supersede`
 * across every headless mode.
 *
 * What it is NOT: it does not know the harness process lifecycle, the
 * durable log, or the flock. It is the credit ledger, not the runner.
 */

import type { HarnessEvent } from "../harness/events.js";
import type { HarnessName, HarnessRunner } from "../harness/runner.js";
import { EventKind } from "../protocol/events.js";
import { MANAGED_INPUT_CAPABILITY } from "../protocol/frames.js";
import {
  classOfEventKind,
  coalesceDroppable,
  type Disposition,
  type Frame,
  type PendingDroppable,
  PROTOCOL_VERSION,
  type ReduceResult,
  supersedeTurn,
} from "../protocol/index.js";

/** What `sendFrame` returns: the host's verdict for the frame we sent. */
type SendResult = ReduceResult | { readonly verdict: "refused"; readonly issue: string };

export interface SequencerDeps {
  readonly managed?: boolean;
  readonly explicitAttachmentId?: string;
  readonly owner?: import("../protocol/process-owner.js").ProcessOwner;
  readonly harness: HarnessName;
  readonly conversationId: string;
  readonly secret: string;
  readonly runner: HarnessRunner;
  /** Lucid mints headless `turnIds` (PLAN 4.3); injected for determinism. */
  readonly mintTurnId: () => string;
  /** The in-process channel to the host — `sendFrame` IS the transport. */
  readonly sendFrame: (frame: Frame) => SendResult;
}

export interface TurnSequencer {
  readonly epoch: number;
  /** Frames the host emitted WITH the attach grant (replayed inputs). */
  readonly attachReplay: readonly Frame[];
  /** The harness session to continue, when the record holds one of this
   * source's harness. Absent means open fresh (RFC-03 R006). */
  readonly resumeSessionId?: string;
  /**
   * Emit a harness event toward the host. Lossless flows unconditionally
   * and supersedes its turn's stale deltas; droppables consume a credit
   * or coalesce latest-wins under their OWN turn until credit arrives
   * (PLAN 4.5).
   */
  emit(turnId: string, event: HarnessEvent): void;
  onCredit(tokens: number): void;
  disposition(inputId: string, outcome: Disposition, note?: string): void;
  detachOnce(reason: "yield" | "shutdown"): void;
}

export class HeadlessError extends Error {
  override readonly name = "HeadlessError";
}

/**
 * Create the sequencer: attach handshake, transactional per-epoch `n`
 * and credit balance, turn-owned pending buffer, dispositions,
 * detach-once. Hidden behind a small, deep interface so the two
 * headless modes differ only in `Runner` + input arrival.
 */
export const createSequencer = (
  deps: SequencerDeps,
  profile: "headless-session" | "headless-turn",
  resumeFrom?: number,
): TurnSequencer => {
  const result = deps.sendFrame({
    kind: "attach",
    conversationId: deps.conversationId,
    profile,
    secret: deps.secret,
    version: PROTOCOL_VERSION,
    // Which harness this source drives. A headless attach without it is
    // refused: it is what attributes this writer's identity events, so a
    // later attach of the same harness can be told which session to resume.
    harness: deps.harness,
    ...(deps.managed
      ? {
          capabilities: [MANAGED_INPUT_CAPABILITY],
          ...(deps.explicitAttachmentId
            ? {
                attachmentOrigin: "explicit" as const,
                explicitAttachmentId: deps.explicitAttachmentId,
              }
            : { attachmentOrigin: "automatic" as const }),
        }
      : {}),
    ...(deps.owner === undefined ? {} : { owner: deps.owner }),
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  });
  if (result.verdict !== "accepted" || !("record" in result))
    throw new HeadlessError(`attach refused: ${"issue" in result ? result.issue : "unknown"}`);
  const epoch = result.record.epoch;
  const attachReplay: Frame[] = result.effects.flatMap((e) =>
    e.type === "send" && e.frame.kind !== "attach-ok" ? [e.frame] : [],
  );
  // RFC-03: the harness session this source should continue, if the record
  // holds one of this harness. Only lucid derives it - a source that computed
  // its own from the transcript could disagree with the reducer, and only the
  // reducer sees which harness produced which identity.
  const attachOk = result.effects.find((e) => e.type === "send" && e.frame.kind === "attach-ok");
  const resumeSessionId =
    attachOk !== undefined && attachOk.type === "send" && attachOk.frame.kind === "attach-ok"
      ? attachOk.frame.resumeSessionId
      : undefined;

  let n = 0;
  let credits = 0;
  let pending: readonly PendingDroppable<HarnessEvent>[] = [];
  let detached = false;

  /** Refusals that will never clear: the record and this driver disagree
   * about which attachment, epoch or turn is live. Everything else is about
   * one event and leaves the next one able to land. */
  const FATAL_ISSUES = new Set([
    "not-attached",
    "stale-epoch",
    "future-epoch",
    "turn-id-reused",
    "gap-n",
    "dupe-n",
  ]);

  /** Stops a stand-in that is itself refused from recursing. */
  let substituting = false;

  const sendEvent = (turnId: string, event: HarnessEvent): boolean => {
    const attempt = n + 1;
    const verdict = deps.sendFrame({
      kind: "event",
      epoch,
      n: attempt,
      turnId,
      event: event as unknown as Record<string, unknown>,
    });
    if (verdict.verdict === "accepted") {
      n = attempt;
      return true;
    }
    if ("issue" in verdict && verdict.issue === "no-credit") {
      credits = 0;
      pending = coalesceDroppable(pending, turnId, event);
      return false;
    }
    // Every other refusal used to end here, discarded, with nothing written
    // and nothing said. `n` does not advance, so one refusal made every event
    // after it fail the same way, and the driver went on dispositioning
    // inputs and writing artifacts - alive to look at, recording nothing the
    // agent said. A record in use ran that way for a day.
    //
    // Refusals split by whether they can clear.
    const issue = "issue" in verdict ? String(verdict.issue) : "refused";
    if (FATAL_ISSUES.has(issue)) {
      // Structural. The record and this driver disagree about which
      // attachment, epoch, or turn is live, and no later event fares better.
      // Stopping loudly beats running deaf.
      throw new HeadlessError(
        `the record refused a ${event.kind} event on turn ${turnId}: ${issue}. ` +
          "Nothing this driver says can be recorded, so it is stopping rather " +
          "than running deaf.",
      );
    }
    if (classOfEventKind(event.kind) === "droppable") {
      pending = coalesceDroppable(pending, turnId, event);
      return false;
    }
    // This one event cannot be recorded - too large for the frame, most
    // often. The next one may be fine, so the turn carries on. What must not
    // happen is silence: a stand-in says the event existed and why it is not
    // here, which is the difference between a gap a reader can see and a gap
    // that looks like the harness saying nothing.
    if (!substituting) {
      substituting = true;
      try {
        sendEvent(turnId, {
          kind: EventKind.error,
          message: `a ${event.kind} event could not be recorded (${issue}); it is missing from this transcript`,
          terminal: false,
        } as unknown as HarnessEvent);
      } finally {
        substituting = false;
      }
    }
    return false;
  };

  const flushPending = (): void => {
    while (credits > 0 && pending.length > 0) {
      const [next, ...rest] = pending;
      pending = rest;
      if (next !== undefined) {
        credits -= 1;
        sendEvent(next.turnId, next.event);
      }
    }
  };

  return {
    epoch,
    attachReplay,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    emit: (turnId: string, event: HarnessEvent): void => {
      if (classOfEventKind(event.kind) === "lossless") {
        pending = supersedeTurn(pending, turnId);
        sendEvent(turnId, event);
        return;
      }
      if (credits > 0) {
        credits -= 1;
        sendEvent(turnId, event);
        return;
      }
      pending = coalesceDroppable(pending, turnId, event);
    },
    onCredit: (tokens: number): void => {
      credits += tokens;
      flushPending();
    },
    disposition: (inputId: string, outcome: Disposition, note?: string): void => {
      deps.sendFrame({
        kind: "disposition",
        epoch,
        inputId,
        outcome,
        ...(note === undefined ? {} : { note }),
      });
    },
    detachOnce: (reason: "yield" | "shutdown"): void => {
      if (detached) return;
      detached = true;
      deps.sendFrame({ kind: "detach", epoch, reason });
    },
  };
};
