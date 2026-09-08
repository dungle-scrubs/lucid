import { recoveryPolicy } from "./execution.js";
import { supportsManagedInput } from "./frames.js";
import type { ChannelState } from "./reducer.js";

export interface ExecutionView {
  readonly inputId: string;
  readonly attempt: number;
  readonly status:
    | "pending"
    | "starting"
    | "running"
    | "held"
    | "completed"
    | "failed"
    | "uncertain";
  readonly reason: string;
  readonly code?: string;
  readonly actions: readonly ("retry" | "continue-fresh")[];
  readonly acknowledgeEffects: boolean;
}

/** Browser and hub share the same projection of durable execution facts. */
export function executionViews(
  state: ChannelState,
  alive: boolean,
  terminal: boolean | null = false,
): readonly ExecutionView[] {
  return Object.entries(state.executions).map(([inputId, execution]): ExecutionView => {
    const base = {
      inputId,
      attempt: execution.attempt,
      ...recoveryPolicy(execution),
    } as const;
    switch (execution.kind) {
      case "requested":
      case "retry-authorized":
      case "fresh-authorized":
        if (terminal !== false || (alive && !supportsManagedInput(state.attachment?.capabilities)))
          return {
            ...base,
            status: "held",
            code: "E-HUB-03",
            reason: "Upgrade the attached source or wait for it to exit. Your prompt is saved.",
          };
        return {
          ...base,
          status: "pending",
          reason: "Your prompt is saved and waiting for an available worker.",
        };
      case "held":
        return {
          ...base,
          status: "held",
          code: execution.hold.code,
          reason: execution.hold.reason,
        };
      case "attempt-started":
        return {
          ...base,
          status: Object.hasOwn(state.appliedInputs, inputId) ? "running" : "starting",
          reason: alive
            ? "The worker is handling this prompt."
            : "The worker stopped. Checking the recorded outcome before recovery.",
        };
      case "attempt-ended": {
        const outcome = execution.outcome;
        if (outcome.kind === "completed")
          return { ...base, status: "completed", reason: "Completed." };
        const beforeStart = outcome.kind === "pre-start-failed";
        return {
          ...base,
          status: beforeStart ? "held" : outcome.kind === "uncertain" ? "uncertain" : "failed",
          code: outcome.failure.code,
          reason: outcome.failure.reason,
        };
      }
    }
    const unexpected: never = execution;
    throw new Error(`Unknown execution state: ${String(unexpected)}`);
  });
}
