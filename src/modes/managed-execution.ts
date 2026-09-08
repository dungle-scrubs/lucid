import { EventKind } from "../protocol/events.js";
import { deriveAttemptOutcome } from "../protocol/execution.js";
import type { Frame } from "../protocol/frames.js";
import type { ConversationHost } from "../store/conversation-host.js";
import type { ManagedPreparation } from "./managed-preparation.js";
import { createManagedPreparation } from "./managed-preparation.js";

interface OwnedAttempt {
  readonly attempt: number;
  readonly inputId: string;
  mayHaveRun: boolean;
  refused: false | "harness-refusal" | "dispatch-not-called";
}
const executionEvents: ReadonlySet<string> = new Set([
  EventKind.message,
  EventKind.token,
  EventKind.tool,
  EventKind.question,
]);
export interface ManagedExecution {
  dispatchRejected(turnId: string, evidence: "harness-refusal" | "dispatch-not-called"): void;
  busy(): boolean;
  /** Called only after the source has settled its owned native processes. */
  close(): void;
  offeredPath(turnId: string): string | undefined;
  readonly prepare: (
    input: Parameters<ManagedPreparation["prepare"]>[0],
  ) => Promise<Awaited<ReturnType<ManagedPreparation["prepare"]>> & { readonly notice?: string }>;
  readonly sendFrame: (frame: Frame) => ReturnType<ConversationHost["handleFrame"]>;
  /** The source has drained this turn, including its process cleanup. */
  turnSettled(turnId: string): void;
}

export class ExecutionSettlementError extends Error {
  readonly code = "E-HUB-07";
  constructor(readonly issue: string) {
    super(`Execution settlement was refused (${issue}). Reconcile the record before continuing.`);
    this.name = "ExecutionSettlementError";
  }
}

/** Keeps process-local cleanup evidence beside the durable attempt it names.
 * A crash before settlement leaves that attempt for conservative recovery. */
export function createManagedExecution(
  deps: Parameters<typeof createManagedPreparation>[0],
): ManagedExecution {
  const preparation = createManagedPreparation(deps);
  const owned = new Map<string, OwnedAttempt>();
  let preparing = 0;
  const { host } = deps;
  const refusedWrite = (issue: string): never => {
    throw new ExecutionSettlementError(issue);
  };
  const turnSettled = (turnId: string): void => {
    const attempt = owned.get(turnId);
    if (!attempt) return;
    try {
      const state = host.state();
      const execution = state.executions[attempt.inputId];
      if (
        execution?.kind !== "attempt-started" ||
        execution.turnId !== turnId ||
        execution.attempt !== attempt.attempt
      )
        return;
      const outcome = deriveAttemptOutcome(
        state,
        execution,
        !attempt.mayHaveRun && attempt.refused,
      );
      const settled = host.writeExecution({
        kind: "attempt-ended",
        inputId: attempt.inputId,
        attempt: attempt.attempt,
        turnId,
        outcome,
      });
      if (settled.verdict === "refused") refusedWrite(settled.issue);
      const native = state.contextTurns[turnId];
      if (
        outcome.kind === "completed" &&
        native?.sessionId &&
        !native.ambiguous &&
        (execution.native.kind === "fresh" || execution.native.sessionId === native.sessionId)
      ) {
        const confirmed = host.confirmConversationContext(turnId);
        if (confirmed.verdict === "refused") refusedWrite(confirmed.issue);
      }
    } finally {
      owned.delete(turnId);
      preparation.release(turnId);
    }
  };
  return {
    dispatchRejected: (turnId, evidence) => {
      const attempt = owned.get(turnId);
      if (attempt) attempt.refused = evidence;
    },
    busy: () => preparing > 0 || owned.size > 0,
    close: () => {
      let failure: unknown;
      for (const turnId of owned.keys()) {
        try {
          turnSettled(turnId);
        } catch (cause) {
          failure ??= cause;
        }
      }
      preparation.close();
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error("Execution settlement failed", { cause: failure });
    },
    offeredPath: preparation.offeredPath,
    prepare: async (input) => {
      preparing++;
      try {
        const result = await preparation.prepare(input);
        if (result.kind === "held") {
          if (result.issue) refusedWrite(result.issue);
          return result;
        }
        const execution = host.state().executions[input.inputId];
        if (execution?.kind !== "attempt-started" || execution.turnId !== input.turnId) {
          preparation.release(input.turnId);
          return refusedWrite("execution-stale");
        }
        owned.set(input.turnId, {
          attempt: execution.attempt,
          inputId: input.inputId,
          mayHaveRun: false,
          refused: false,
        });
        return result.summary
          ? {
              ...result,
              notice: `Older conversation context was summarized with ${result.summary.model}. The complete record remains available in the offered context copy.`,
            }
          : result;
      } finally {
        preparing--;
      }
    },
    sendFrame: (frame) => {
      const attempt = frame.kind === "event" ? owned.get(frame.turnId) : undefined;
      if (
        attempt &&
        !attempt.mayHaveRun &&
        frame.kind === "event" &&
        executionEvents.has(String(frame.event.kind))
      )
        attempt.mayHaveRun = true;
      const result = host.handleFrame(JSON.stringify(frame));
      if (
        attempt &&
        result.verdict === "accepted" &&
        frame.kind === "event" &&
        frame.event.kind === EventKind.failure &&
        frame.event.class === "rejected"
      )
        attempt.refused = "harness-refusal";
      return result;
    },
    turnSettled,
  };
}
