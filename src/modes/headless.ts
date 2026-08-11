/**
 * The headless SOURCE: lucid-owned adapters that drive a harness through
 * the normalizer's runners and speak the chat protocol to the store host.
 * Owns the HarnessEvent -> event-frame mapping (lucid mints headless
 * turnIds; runner events, frames, and dispositions correlate on one id),
 * input delivery per mode (session: send now, disposition reports what
 * HAPPENED; turn: queue between turns), and the droppable credit
 * discipline: the per-epoch n and the credit balance are TRANSACTIONAL
 * against the host's verdict (committed only on acceptance, requeued on
 * no-credit), pending droppables stay owned by the turn that produced
 * them, and a turn's lossless event supersedes its stale deltas
 * (protocol/events.ts owns that policy). Transport is deferred by
 * decision: `sendFrame` IS the in-process channel and its returned
 * verdict is how the source keeps its counters honest. NOT responsible
 * for durability (the host owns the log) or spawning semantics (the
 * runners own processes). Idle-session heartbeats are wired with the
 * real runtime loop (M5.4); during M5.2 lease renewal rides on frames.
 */

import type { RunnerDeps } from "@dungle-scrubs/harness-cli/src/execution/deps.js";
import type { HarnessEvent } from "@dungle-scrubs/harness-cli/src/execution/events.js";
import { openSession } from "@dungle-scrubs/harness-cli/src/execution/open-session.js";
import { streamTurn } from "@dungle-scrubs/harness-cli/src/execution/stream-turn.js";
import type { HarnessDescriptor } from "@dungle-scrubs/harness-cli/src/knowledge/descriptor.js";
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

/** What sendFrame returns: the host's verdict for the frame we sent (the
 * in-process transport hands it back directly). */
type SendResult = ReduceResult | { readonly verdict: "refused"; readonly issue: string };

export interface HeadlessDeps {
  readonly harness: HarnessDescriptor;
  readonly conversationId: string;
  readonly secret: string;
  readonly runner: Pick<RunnerDeps, "spawn" | "clock" | "signal" | "stallMs" | "log">;
  /** lucid mints headless turnIds (PLAN 4.3); injected for determinism. */
  readonly mintTurnId: () => string;
  /** The in-process channel to the host. */
  readonly sendFrame: (frame: Frame) => SendResult;
}

interface SourceChannel {
  /** Host -> source frames (input, control, credit, lease, event-ack). */
  readonly receive: (frame: Frame) => void;
  readonly close: () => void;
}

class HeadlessError extends Error {
  override readonly name = "HeadlessError";
}

/** Shared source spine: attach handshake, transactional per-epoch n and
 * credit balance, turn-owned pending buffer, dispositions, detach-once. */
const attachSource = (
  deps: HeadlessDeps,
  profile: "headless-session" | "headless-turn",
  resumeFrom?: number,
) => {
  const result = deps.sendFrame({
    kind: "attach",
    conversationId: deps.conversationId,
    profile,
    secret: deps.secret,
    version: PROTOCOL_VERSION,
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  });
  if (result.verdict !== "accepted" || !("record" in result))
    throw new HeadlessError(`attach refused: ${"issue" in result ? result.issue : "unknown"}`);
  const epoch = result.record.epoch;
  // Frames the host emitted WITH the attach grant (replayed inputs): the
  // caller processes them once its receive machinery exists - they must
  // not be lost to construction ordering.
  const attachReplay: Frame[] = result.effects.flatMap((e) =>
    e.type === "send" && e.frame.kind !== "attach-ok" ? [e.frame] : [],
  );

  let n = 0;
  let credits = 0;
  let pending: readonly PendingDroppable<HarnessEvent>[] = [];
  let detached = false;

  /** Transactional: n is committed only when the host accepts. On
   * no-credit the event returns to its turn's pending slot and the local
   * balance zeroes - the discipline reducer.ts documents (same n resent
   * once credit arrives). Any other refusal rolls back and drops; the
   * host already recorded the named issue. */
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
    }
    return false;
  };

  const flushPending = (): void => {
    while (credits > 0 && pending.length > 0) {
      const [next, ...rest] = pending;
      pending = rest;
      if (next !== undefined) {
        credits -= 1;
        // A refusal inside sendEvent re-queues and zeroes credits, which
        // also terminates this loop.
        sendEvent(next.turnId, next.event);
      }
    }
  };

  return {
    epoch,
    attachReplay,
    /** Lossless flows unconditionally and supersedes its turn's stale
     * deltas; droppables consume a credit or coalesce latest-wins under
     * their OWN turn until credit arrives (PLAN 4.5). */
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

/** Mode 2: one persistent process serves many turns. Inputs are sent into
 * the live session; the runner's answer (started vs queued) is what the
 * disposition reports, and a queued input flips to applied when the turn
 * it starts actually begins. A dead session answers `rejected` - the
 * reducer returns the input to the queue, never drops it. */
export const openHeadlessSession = (
  deps: HeadlessDeps & { readonly sessionId: string },
): SourceChannel => {
  const source = attachSource(deps, "headless-session");
  const session = openSession(deps.harness, { sessionId: deps.sessionId }, deps.runner);

  let currentTurnId = deps.mintTurnId();
  /** FIFO of sends awaiting their turn to start (A-001: the runner starts
   * queued sends in order at boundaries). */
  const expectedTurns: Array<{ inputId: string; applied: boolean }> = [];

  const pump = (async () => {
    for await (const turn of session.turns) {
      // This turn consumes the oldest expected send; if it was queued,
      // NOW it is applied.
      const expected = expectedTurns.shift();
      if (expected !== undefined && !expected.applied)
        source.disposition(expected.inputId, "applied", "queued turn started");
      for await (const event of turn) {
        source.emit(currentTurnId, event);
      }
      currentTurnId = deps.mintTurnId();
    }
  })();
  pump
    .catch(() => {
      // Frame-path failures already surfaced as named refusals at the
      // host; the channel itself is done either way.
    })
    .finally(() => {
      // The session ended (clean close or process death): release the
      // channel so the conversation is not left attached to a corpse.
      source.detachOnce("shutdown");
    });

  return {
    receive: (frame: Frame): void => {
      switch (frame.kind) {
        case "input": {
          let sent: { disposition: "started" | "queued" };
          try {
            sent = session.send(frame.text);
          } catch {
            source.disposition(frame.id, "rejected", "session closed");
            return;
          }
          if (sent.disposition === "started") {
            expectedTurns.push({ inputId: frame.id, applied: true });
            source.disposition(frame.id, "applied");
          } else {
            expectedTurns.push({ inputId: frame.id, applied: false });
            source.disposition(frame.id, "queued");
          }
          return;
        }
        case "credit":
          source.onCredit(frame.tokens);
          return;
        default:
          // attach-ok/event-ack/lease need no action in-process (the
          // sendFrame result already carried the grant; replay buffers
          // are the host's).
          return;
      }
    },
    close: (): void => {
      source.detachOnce("shutdown");
      void session.close();
    },
  };
};

/** Mode 1: one process per turn. Inputs queue between turns (a turn in
 * flight is never interjected); each becomes the next spawned turn's
 * prompt (queued -> applied when it starts), and successive turns resume
 * the session id the previous turn announced, so the conversation keeps
 * its memory across processes. */
export const openHeadlessTurns = (
  deps: HeadlessDeps & { readonly resume?: string },
): SourceChannel => {
  const source = attachSource(deps, "headless-turn");
  const queue: Array<{ id: string; text: string }> = [];
  let running = false;
  let closed = false;
  let resumeId = deps.resume;
  let activeTurn: AsyncIterator<HarnessEvent> | null = null;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (!closed) {
        const next = queue.shift();
        if (next === undefined) break;
        const turnId = deps.mintTurnId();
        source.disposition(next.id, "applied", "turn started");
        const turn = streamTurn(
          deps.harness,
          { prompt: next.text, ...(resumeId === undefined ? {} : { resume: resumeId }) },
          { ...deps.runner, turnId },
        );
        const iterator = turn[Symbol.asyncIterator]();
        activeTurn = iterator;
        while (true) {
          const step = await iterator.next();
          if (step.done === true) break;
          const event = step.value;
          // Continuity: the announced session id is what the NEXT turn
          // resumes - one conversation across many processes.
          if (event.kind === "identity") resumeId = event.sessionId;
          source.emit(turnId, event);
        }
        activeTurn = null;
      }
    } finally {
      activeTurn = null;
      running = false;
    }
  };
  const kick = (): void => {
    drain().catch(() => {
      // A frame-path failure mid-turn already produced named refusals at
      // the host; release the channel rather than strand it.
      source.detachOnce("shutdown");
    });
  };

  return {
    receive: (frame: Frame): void => {
      switch (frame.kind) {
        case "input":
          // Between turns or mid-turn alike: the input QUEUES (the mode's
          // contract), and the disposition says so.
          queue.push({ id: frame.id, text: frame.text });
          source.disposition(frame.id, "queued");
          kick();
          return;
        case "credit":
          source.onCredit(frame.tokens);
          return;
        default:
          return;
      }
    },
    close: (): void => {
      closed = true;
      // Stop the in-flight turn's pump; streamTurn's early-return path
      // performs its own child shutdown escalation.
      void activeTurn?.return?.(undefined);
      source.detachOnce("shutdown");
    },
  };
};
