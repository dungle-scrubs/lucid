import type { HarnessEvent } from "../harness/events.js";
import {
  classifyPiResume,
  isAgentEventKind,
  isNativeExit3,
  type PiVerification,
  piNativeTurn,
} from "../harness/pi-verification.js";
import type {
  NativeApprovalChannel,
  NativeApprovalEvents,
  StreamTurnOptions,
} from "../harness/runner.js";
import { EventKind } from "../protocol/events.js";
import { type AttemptOutcome, deriveAttemptOutcome } from "../protocol/execution.js";
import type { Frame } from "../protocol/frames.js";
import type { ConversationHost } from "../store/conversation-host.js";
import { createManagedApprovals } from "./managed-approvals.js";
import type { ManagedPreparation } from "./managed-preparation.js";
import { createManagedPreparation } from "./managed-preparation.js";

interface OwnedAttempt {
  approvals?: ReturnType<typeof createManagedApprovals>;
  readonly attempt: number;
  readonly epoch: number;
  readonly inputId: string;
  mayHaveRun: boolean;
  refused: false | "harness-refusal" | "dispatch-not-called";
  pi?: { readonly verification: PiVerification; agentEvents: boolean; nativeExit3: boolean };
}
const executionEvents: ReadonlySet<string> = new Set([
  EventKind.approvalRequest,
  EventKind.message,
  EventKind.token,
  EventKind.tool,
  EventKind.question,
]);
export interface ManagedExecution {
  connectApprovals(turnId: string, channel: NativeApprovalChannel): NativeApprovalEvents;
  recordChanged(): void;
  dispatchRejected(turnId: string, evidence: "harness-refusal" | "dispatch-not-called"): void;
  busy(): boolean;
  /** Called only after the source has settled its owned native processes. */
  close(): void;
  offeredPath(turnId: string): string | undefined;
  readonly prepare: (input: Parameters<ManagedPreparation["prepare"]>[0]) => Promise<
    Awaited<ReturnType<ManagedPreparation["prepare"]>> & {
      readonly nativeApprovals?: StreamTurnOptions["nativeApprovals"];
      readonly nativeTurn?: StreamTurnOptions["native"];
      readonly nativeDispatch?: <T>(invoke: () => T) => T;
      readonly notice?: string;
    }
  >;
  readonly sendFrame: (frame: Frame) => ReturnType<ConversationHost["handleFrame"]>;
  /** Every raw harness event of an owned turn, before the sequencer drops
   * or coalesces any: the evidence that the model may have run. */
  observeEvent(turnId: string, event: HarnessEvent): void;
  /** The source has drained this turn, including its process cleanup. */
  turnSettled(turnId: string): void;
}

/** RFC 28's outcome table over the ordinary derivation. A verified resume keeps
 * it; a proven refusal is a pre-model refusal; anything else never counts as
 * a completed continuation of the bound session. */
function piAttemptOutcome(
  pi: NonNullable<OwnedAttempt["pi"]>,
  derived: AttemptOutcome,
): AttemptOutcome {
  const result = classifyPiResume(pi.verification, {
    completed: derived.kind === "completed",
    agentEvents: pi.agentEvents,
    nativeExit3: pi.nativeExit3,
  });
  if (result.kind === "verified") return derived;
  if (result.kind === "refused")
    return {
      kind: "pre-start-failed",
      failure: {
        code: "E-HUB-05",
        evidence: "harness-refusal",
        reason: `Pi did not open the bound session (${result.reason}), so the resume stopped before the model. The original session may be gone. The note stays saved; retry after repair.`,
      },
    };
  // hcn's own refusal or a dispatch that never ran proves nothing reached
  // Pi; every other unverified end holds as uncertain (RFC 28 row 3).
  if (derived.kind === "pre-start-failed" || derived.kind === "uncertain") return derived;
  return {
    kind: "uncertain",
    failure: {
      code: "E-HUB-07",
      evidence: "terminal-error",
      reason: `Lucid could not confirm that Pi resumed the bound session (${result.detail}). The turn's output is not accepted as its continuation. Inspect the workspace before continuing.`,
    },
  };
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
      const derived = deriveAttemptOutcome(
        state,
        execution,
        !attempt.mayHaveRun && attempt.refused,
      );
      const outcome = attempt.pi ? piAttemptOutcome(attempt.pi, derived) : derived;
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
      if (state.connection) {
        const cleaned = host.recordNativeExecution({ kind: "settled", turnId });
        if (cleaned.verdict === "refused") refusedWrite(cleaned.issue);
      }
    } finally {
      owned.delete(turnId);
      preparation.release(turnId);
    }
  };
  const managed: ManagedExecution = {
    connectApprovals: (turnId, channel) => {
      const attempt = owned.get(turnId);
      const current = (): boolean => {
        const state = host.state();
        const execution = attempt && state.executions[attempt.inputId];
        return (
          !!attempt &&
          owned.get(turnId) === attempt &&
          state.epoch === attempt.epoch &&
          execution?.kind === "attempt-started" &&
          execution.turnId === turnId &&
          execution.attempt === attempt.attempt
        );
      };
      if (!attempt || attempt.approvals || !current()) {
        channel.cancel();
        return refusedWrite("approval-unavailable");
      }
      const approvals = createManagedApprovals({
        attempt: {
          attempt: attempt.attempt,
          epoch: attempt.epoch,
          inputId: attempt.inputId,
          turnId,
        },
        channel,
        current,
        host,
      });
      attempt.approvals = approvals;
      return {
        closed: approvals.closed,
        event: (event) => {
          if (executionEvents.has(event.kind)) attempt.mayHaveRun = true;
          approvals.event(event);
        },
      };
    },
    recordChanged: () => {
      for (const attempt of owned.values()) attempt.approvals?.recordChanged();
    },
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
          epoch: execution.epoch,
          inputId: input.inputId,
          mayHaveRun: false,
          refused: false,
          ...(result.piVerification
            ? {
                pi: {
                  verification: result.piVerification,
                  agentEvents: false,
                  nativeExit3: false,
                },
              }
            : {}),
        });
        return {
          ...result,
          ...(result.nativeFingerprint !== undefined && result.nativeContinuation === "resume"
            ? {
                // RFC 35: an ordinary fingerprinted resume, admitted through the
                // same native-execution fence as the approval transport.
                nativeTurn: result.piVerification
                  ? piNativeTurn(result.piVerification, result.nativeFingerprint)
                  : { env: {}, extensions: [], settingsFingerprint: result.nativeFingerprint },
                nativeDispatch: <T>(invoke: () => T): T => {
                  let value: T | undefined;
                  let invoked = false;
                  const admitted = host.dispatchNativeExecution(input.turnId, () => {
                    value = invoke();
                    invoked = true;
                    return undefined;
                  });
                  if (admitted.verdict === "refused" || !invoked) {
                    managed.dispatchRejected(input.turnId, "dispatch-not-called");
                    return refusedWrite(
                      admitted.verdict === "refused" ? admitted.issue : "dispatch-not-called",
                    );
                  }
                  return value as T;
                },
              }
            : {}),
          ...(result.nativeFingerprint === undefined || result.nativeContinuation === "resume"
            ? {}
            : {
                nativeApprovals: {
                  fingerprint: result.nativeFingerprint,
                  dispatch: (invoke: () => undefined): undefined => {
                    const admitted = host.dispatchNativeExecution(input.turnId, invoke);
                    if (admitted.verdict === "refused") {
                      managed.dispatchRejected(input.turnId, "dispatch-not-called");
                      refusedWrite(admitted.issue);
                    }
                  },
                  connect: (channel: NativeApprovalChannel) =>
                    managed.connectApprovals(input.turnId, channel),
                },
              }),
          ...(result.summary
            ? {
                notice: `Older conversation context was summarized with ${result.summary.model}. The complete record remains available in the offered context copy.`,
              }
            : {}),
        };
      } finally {
        preparing--;
      }
    },
    observeEvent: (turnId, event) => {
      const attempt = owned.get(turnId);
      if (!attempt) return;
      if (executionEvents.has(event.kind)) attempt.mayHaveRun = true;
      if (attempt.pi) {
        if (isAgentEventKind(event.kind)) attempt.pi.agentEvents = true;
        if (isNativeExit3(event as Readonly<Record<string, unknown>>))
          attempt.pi.nativeExit3 = true;
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
        frame.event.kind === EventKind.identity &&
        frame.event.authority === "harness-minted" &&
        host.state().connection
      ) {
        const started = host.recordNativeExecution({ kind: "started", turnId: frame.turnId });
        if (started.verdict === "refused") refusedWrite(started.issue);
      }
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
  return managed;
}
