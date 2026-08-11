/**
 * The headless SOURCE: lucid-owned adapters that drive a harness through
 * the normalizer's runners and speak the chat protocol to the store host.
 * Owns the HarnessEvent -> event-frame mapping (lucid mints headless
 * turnIds, so runner events, frames, and dispositions all correlate on
 * one id), input delivery per mode (session: send now, disposition says
 * what HAPPENED; turn: queue between turns), and the droppable-class
 * credit discipline (lossless always sent; droppables consume credit or
 * coalesce latest-wins until credit arrives). Transport is deferred by
 * decision: `sendFrame` IS the in-process channel, and its returned
 * result is how the source reads its attach grant. NOT responsible for
 * durability (the host owns the log) or for spawning semantics (the
 * runners own processes; this module only maps).
 * Idle-session heartbeats are wired with the real runtime loop (M5.4);
 * during M5.2 lease renewal rides on event frames.
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
  PROTOCOL_VERSION,
  type ReduceResult,
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

/** Shared source spine: attach handshake, per-epoch n counter, and the
 * droppable/lossless send discipline. */
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

  let n = 0;
  let credits = 0;
  let pending: readonly HarnessEvent[] = [];

  const sendEvent = (turnId: string, event: HarnessEvent): void => {
    n += 1;
    deps.sendFrame({
      kind: "event",
      epoch,
      n,
      turnId,
      event: event as unknown as Record<string, unknown>,
    });
  };

  return {
    epoch,
    /** Lossless flows unconditionally; droppables consume a credit or
     * coalesce latest-wins until one arrives (PLAN 4.5). */
    emit: (turnId: string, event: HarnessEvent): void => {
      if (classOfEventKind(event.kind) === "lossless") {
        sendEvent(turnId, event);
        return;
      }
      if (credits > 0) {
        credits -= 1;
        sendEvent(turnId, event);
        return;
      }
      pending = coalesceDroppable(pending, event);
    },
    onCredit: (tokens: number, turnId: string): void => {
      credits += tokens;
      while (credits > 0 && pending.length > 0) {
        const [next, ...rest] = pending;
        pending = rest;
        if (next !== undefined) {
          credits -= 1;
          sendEvent(turnId, next);
        }
      }
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
    detach: (reason: "yield" | "shutdown"): void => {
      deps.sendFrame({ kind: "detach", epoch, reason });
    },
  };
};

/** Mode 2: one persistent process serves many turns. Inputs are sent into
 * the live session; the runner's answer (started vs queued) is what the
 * disposition reports - what HAPPENED, not what was requested. */
export const openHeadlessSession = (
  deps: HeadlessDeps & { readonly sessionId: string },
): SourceChannel => {
  const source = attachSource(deps, "headless-session");
  const session = openSession(deps.harness, { sessionId: deps.sessionId }, deps.runner);

  let currentTurnId = deps.mintTurnId();

  // Consume turns as they occur; every runner event maps to one frame
  // stamped with the lucid-minted turnId of the turn it belongs to.
  const pump = (async () => {
    for await (const turn of session.turns) {
      for await (const event of turn) {
        source.emit(currentTurnId, event);
      }
      // Turn boundary: the next turn gets a fresh lucid-minted id.
      currentTurnId = deps.mintTurnId();
    }
  })();
  pump.catch(() => {
    // The runner surfaces failures as error/done events already mapped
    // above; a pump crash beyond that has nothing protocol-shaped to say.
  });

  return {
    receive: (frame: Frame): void => {
      switch (frame.kind) {
        case "input": {
          const sent = session.send(frame.text);
          source.disposition(frame.id, sent.disposition === "started" ? "applied" : "queued");
          return;
        }
        case "credit":
          source.onCredit(frame.tokens, currentTurnId);
          return;
        default:
          // attach-ok/event-ack/lease need no action in-process (the
          // sendFrame result already carried the grant; replay buffers
          // are the host's).
          return;
      }
    },
    close: (): void => {
      source.detach("shutdown");
      void session.close();
    },
  };
};

/** Mode 1: one process per turn. Inputs queue between turns (a turn in
 * flight is never interjected); each queued input becomes the next
 * spawned turn's prompt, and its disposition flips queued -> applied
 * when that turn actually starts. */
export const openHeadlessTurns = (
  deps: HeadlessDeps & { readonly resume?: string },
): SourceChannel => {
  const source = attachSource(deps, "headless-turn");
  const queue: Array<{ id: string; text: string }> = [];
  let running = false;
  let closed = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    while (!closed) {
      const next = queue.shift();
      if (next === undefined) break;
      const turnId = deps.mintTurnId();
      source.disposition(next.id, "applied", "turn started");
      const turn = streamTurn(
        deps.harness,
        { prompt: next.text, ...(deps.resume === undefined ? {} : { resume: deps.resume }) },
        { ...deps.runner, turnId },
      );
      for await (const event of turn) {
        source.emit(turnId, event);
      }
    }
    running = false;
  };

  return {
    receive: (frame: Frame): void => {
      switch (frame.kind) {
        case "input":
          // Between turns or mid-turn alike: the input QUEUES (that is
          // the mode's contract), and the disposition says so.
          queue.push({ id: frame.id, text: frame.text });
          source.disposition(frame.id, "queued");
          void drain();
          return;
        case "credit":
          source.onCredit(frame.tokens, "no-turn");
          return;
        default:
          return;
      }
    },
    close: (): void => {
      closed = true;
      source.detach("shutdown");
    },
  };
};
