import { HubError } from "../protocol/hub-errors.js";
import type { ConversationHost } from "../store/conversation-host.js";
import type { createHeadlessHost, HeadlessDeps, SourceChannel } from "./host.js";
import { createManagedExecution, ExecutionSettlementError } from "./managed-execution.js";

/** Adds durable attempt ownership to the existing source factory. */
export function createManagedSource(
  deps: HeadlessDeps,
  profile: "headless-turn" | "headless-session",
  host: ConversationHost,
  createHost: typeof createHeadlessHost,
): SourceChannel {
  if (!deps.cwd || !deps.model || !deps.effort)
    throw new HubError(
      "Choose a working folder and complete driver settings before continuing.",
      "E-HUB-03",
    );
  const execution = createManagedExecution({
    cwd: deps.cwd,
    driver: {
      harness: deps.harness,
      model: deps.model,
      effort: deps.effort,
      profile,
      ...(deps.provider === undefined ? {} : { provider: deps.provider }),
    },
    host,
    runner: deps.runner,
  });
  const notes = [...(deps.notes ?? [])];
  try {
    const opened = createHost(
      {
        ...deps,
        notes,
        managed: true,
        beforeProcess: undefined,
        prepareTurn: execution.prepare,
        sendFrame: execution.sendFrame,
        onTurnSettled: execution.turnSettled,
        onDispatchRejected: execution.dispatchRejected,
        onAttached: () => {
          for (const input of host.state().inputs) {
            if (input.mode !== "queue" || host.state().executions[input.id]) continue;
            const adopted = host.writeExecution({
              kind: "legacy-adopted",
              attempt: 0,
              inputId: input.id,
            });
            if (adopted.verdict === "refused") throw new ExecutionSettlementError(adopted.issue);
          }
          for (const [inputId, attempt] of Object.entries(host.state().executions)) {
            if (attempt.kind !== "attempt-started") continue;
            const result = host.reconcileExecution(inputId, attempt.attempt);
            if (result.verdict === "refused") throw new ExecutionSettlementError(result.issue);
            if (
              result.state.completedTurns[attempt.turnId] !== undefined &&
              result.state.contextTurns[attempt.turnId]?.sessionId
            ) {
              if (
                attempt.native.kind === "resume" &&
                result.state.contextTurns[attempt.turnId]?.sessionId !== attempt.native.sessionId
              ) {
                notes.push(
                  "The completed turn reported a different native session. Its context coverage remains unconfirmed; the next turn must receive the missing recorded context.",
                );
                continue;
              }
              const confirmed = host.confirmConversationContext(attempt.turnId);
              if (confirmed.verdict === "refused")
                throw new ExecutionSettlementError(confirmed.issue);
            }
          }
          return host.recoveryInputs();
        },
      },
      profile,
    );
    const settled = opened.settled.finally(execution.close);
    void settled.catch(() => {});
    return { ...opened, busy: execution.busy, settled };
  } catch (cause) {
    execution.close();
    throw cause;
  }
}
