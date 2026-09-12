import type { HarnessEvent } from "../harness/events.js";
import type { NativeApprovalChannel, NativeApprovalEvents } from "../harness/runner.js";
import { EventKind } from "../protocol/events.js";
import type { ApprovalAttempt, ApprovalState } from "../protocol/native-approvals.js";
import type { ConversationHost } from "../store/conversation-host.js";

interface ManagedApprovals extends NativeApprovalEvents {
  recordChanged(): void;
}

interface ManagedApprovalDeps {
  readonly attempt: ApprovalAttempt;
  readonly channel: NativeApprovalChannel;
  readonly current: () => boolean;
  readonly host: ConversationHost;
}

class ManagedApprovalError extends Error {
  readonly code = "approval-admission-failed";
  constructor(readonly issue: string) {
    super(`The native permission channel stopped (${issue}).`);
    this.name = "ManagedApprovalError";
  }
}

/** Binds one live channel to one durable attempt. Reading the log alone never sends. */
export function createManagedApprovals(deps: ManagedApprovalDeps): ManagedApprovals {
  const { attempt, channel, current, host } = deps;
  let closed = false;
  let failure: Error | undefined;
  let observedRevision = -1;
  const requestIds = new Set<string>();
  const matches = (entry: ApprovalState): boolean =>
    entry.attempt === attempt.attempt &&
    entry.epoch === attempt.epoch &&
    entry.inputId === attempt.inputId &&
    entry.turnId === attempt.turnId;
  const active = (): boolean => !closed && current() && channel.alive();
  const fail = (issue: string): Error => {
    failure ??= new ManagedApprovalError(issue);
    channel.cancel();
    return failure;
  };
  return {
    event: (event: HarnessEvent) => {
      if (closed || !current() || !("v" in event) || event.v !== 1) throw fail("stale-channel");
      if (event.kind === EventKind.approvalRequest && !channel.alive()) throw fail("process-ended");
      const fact =
        event.kind === EventKind.approvalRequest
          ? { ...attempt, kind: "request", request: event }
          : event.kind === EventKind.approvalCleared
            ? { ...event, ...attempt, kind: "cleared" }
            : event.kind === EventKind.approvalDisposition
              ? { ...event, ...attempt, kind: "disposition" }
              : null;
      const requestId =
        "requestId" in event && typeof event.requestId === "string" ? event.requestId : undefined;
      // Track before append: its record callback can fail after the request is durable.
      if (event.kind === EventKind.approvalRequest && requestId) requestIds.add(requestId);
      const result = host.writeApproval(fact, () => !closed && current());
      if (result.verdict === "refused") throw fail(result.issue);
      const saved = requestId ? result.state.approvals[requestId] : undefined;
      if (requestId && (saved?.status === "cleared" || saved?.status === "unavailable"))
        requestIds.delete(requestId);
    },
    recordChanged: () => {
      if (closed) return;
      if (!active()) {
        channel.cancel();
        return;
      }
      const state = host.state();
      if (state.approvalRevision === observedRevision) return;
      observedRevision = state.approvalRevision;
      try {
        for (const requestId of requestIds) {
          const entry = state.approvals[requestId];
          if (!entry || !matches(entry) || entry.status !== "decided") continue;
          const decision = entry.decision;
          const result = host.writeApproval(
            { ...attempt, kind: "write-intent", id: decision.id, requestId: decision.requestId },
            active,
          );
          if (result.verdict === "refused") {
            const latest = result.state.approvals[decision.requestId];
            if (active() && latest && latest.status !== "decided") continue;
            fail(result.issue);
            return;
          }
          channel.answer({
            choiceId: decision.choiceId,
            id: decision.id,
            requestId: decision.requestId,
          });
        }
      } catch (cause) {
        failure = cause instanceof Error ? cause : new ManagedApprovalError("write-failed");
        channel.cancel();
      }
    },
    closed: () => {
      if (closed) return;
      closed = true;
      const state = host.state();
      const reason =
        state.completedTurns[attempt.turnId] === undefined ? "process-ended" : "turn-ended";
      for (const requestId of requestIds) {
        const entry = state.approvals[requestId];
        if (
          !entry ||
          !matches(entry) ||
          entry.status === "cleared" ||
          entry.status === "unavailable"
        )
          continue;
        const result = host.writeApproval({
          ...attempt,
          kind: "cleared",
          reason,
          requestId: entry.request.requestId,
        });
        if (result.verdict === "refused") {
          const latest = result.state.approvals[entry.request.requestId];
          if (latest?.status !== "cleared" && latest?.status !== "unavailable")
            failure ??= new ManagedApprovalError(result.issue);
        }
      }
      requestIds.clear();
      if (failure) throw failure;
    },
  };
}
