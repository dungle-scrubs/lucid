import { refuseExecution } from "./execution-result.js";
import type { ApprovalFact, ApprovalState } from "./native-approval-codec.js";
import { parseApprovalDecision, parseApprovalFact } from "./native-approval-codec.js";
import type { ChannelState, ReduceResult } from "./reducer.js";

export type {
  ApprovalAttempt,
  ApprovalChoice,
  ApprovalDecision,
  ApprovalFact,
  ApprovalRequest,
  ApprovalState,
} from "./native-approval-codec.js";
export {
  parseApprovalDecision,
  parseApprovalFact,
  parseApprovalRequest,
} from "./native-approval-codec.js";

export function browserApprovalFact(state: ChannelState, raw: unknown): ApprovalFact | null {
  const decision = parseApprovalDecision(raw);
  const request = decision && state.approvals[decision.requestId];
  return request && decision
    ? {
        attempt: request.attempt,
        epoch: request.epoch,
        inputId: request.inputId,
        turnId: request.turnId,
        decision,
        kind: "decision",
      }
    : null;
}

/** Protected execution facts only. Generic source events never call this reducer. */
export function reduceApproval(
  state: ChannelState,
  raw: unknown,
  now: number,
  authority: "browser" | "executor" | "none" | "replay",
): ReduceResult {
  const fact = parseApprovalFact(raw);
  const refuse = (
    issue: "invalid-approval" | "approval-conflict" | "approval-unavailable" | "executor-required",
  ) => refuseExecution(state, now, issue);
  if (!fact) return refuse("invalid-approval");
  if (
    authority !== "replay" &&
    (fact.kind === "decision" ? authority !== "browser" : authority !== "executor")
  )
    return refuse("executor-required");
  const requestId =
    fact.kind === "request"
      ? fact.request.requestId
      : fact.kind === "decision"
        ? fact.decision.requestId
        : fact.requestId;
  const previous = state.approvals[requestId];
  const accept = (next: ApprovalState, duplicate = false): ReduceResult => {
    const updated = duplicate
      ? state
      : {
          ...state,
          seq: state.seq + 1,
          approvalRevision: state.seq + 1,
          approvals: { ...state.approvals, [requestId]: next },
        };
    return {
      verdict: "accepted",
      state: updated,
      effects: [],
      record: {
        verdict: "accepted",
        kind: "input",
        conversationId: state.conversationId,
        epoch: state.epoch,
        seq: updated.seq,
        now,
        inputId: fact.inputId,
      },
    };
  };
  if (fact.kind === "decision") {
    const already = Object.values(state.approvals).find(
      (entry) => entry.decision?.id === fact.decision.id,
    );
    if (already?.decision)
      return already.request.requestId === requestId &&
        already.decision.choiceId === fact.decision.choiceId
        ? accept(already, true)
        : refuse("approval-conflict");
  }
  const attempt = state.executions[fact.inputId];
  const request = fact.kind === "request" ? fact.request : previous?.request;
  if (
    !request ||
    fact.epoch !== state.epoch ||
    attempt?.kind !== "attempt-started" ||
    attempt.epoch !== fact.epoch ||
    attempt.attempt !== fact.attempt ||
    attempt.turnId !== fact.turnId ||
    attempt.driver.profile !== "headless-turn" ||
    state.attachment?.profile !== "headless-turn" ||
    attempt.native.kind !== "resume" ||
    attempt.native.sessionId !== request.sessionId
  )
    return refuse("approval-unavailable");
  if (
    previous &&
    (previous.epoch !== fact.epoch ||
      previous.attempt !== fact.attempt ||
      previous.inputId !== fact.inputId ||
      previous.turnId !== fact.turnId)
  )
    return refuse("approval-conflict");
  if (fact.kind === "request") {
    if (previous)
      return JSON.stringify(previous.request) === JSON.stringify(fact.request)
        ? accept(previous, true)
        : refuse("approval-conflict");
    if (
      Object.values(state.approvals).filter(
        (entry) =>
          entry.epoch === fact.epoch &&
          entry.inputId === fact.inputId &&
          entry.attempt === fact.attempt &&
          entry.status !== "cleared" &&
          entry.status !== "unavailable",
      ).length >= 32
    )
      return refuse("approval-unavailable");
    return accept({
      attempt: fact.attempt,
      epoch: fact.epoch,
      inputId: fact.inputId,
      request: fact.request,
      seq: state.seq + 1,
      status: "pending",
      turnId: fact.turnId,
    });
  }
  if (!previous) return refuse("approval-unavailable");
  if (fact.kind === "cleared") {
    if (previous.status === "cleared" || previous.status === "unavailable")
      return accept(previous, true);
    return accept({
      ...previous,
      reason: fact.reason,
      status:
        fact.reason === "native-resolved" || fact.reason === "turn-ended"
          ? "cleared"
          : "unavailable",
    });
  }
  if (fact.kind === "disposition") {
    if (
      !previous.decision ||
      previous.decision.id !== fact.id ||
      previous.decision.status === "decided"
    )
      return refuse("approval-unavailable");
    if (fact.status === "rejected") {
      if (previous.decision.status === "rejected")
        return previous.decision.reason === fact.reason
          ? accept(previous, true)
          : refuse("approval-conflict");
      if (previous.decision.status !== "sending") return refuse("approval-conflict");
      const decision = { ...previous.decision, reason: fact.reason, status: "rejected" as const };
      return previous.status === "cleared" || previous.status === "unavailable"
        ? accept({ ...previous, decision })
        : accept({ ...previous, decision, reason: "decision-rejected", status: "unavailable" });
    }
    if (previous.decision.status === "rejected") return refuse("approval-conflict");
    if (previous.decision.status === "sent") return accept(previous, true);
    const decision = { ...previous.decision, status: "sent" as const };
    return previous.status === "cleared" || previous.status === "unavailable"
      ? accept({ ...previous, decision })
      : accept({ ...previous, decision, status: "sent" });
  }
  if (fact.kind === "decision") {
    if (
      previous.status !== "pending" ||
      !request.choices.some((choice) => choice.id === fact.decision.choiceId)
    )
      return refuse("approval-unavailable");
    return accept({
      ...previous,
      status: "decided",
      decision: { ...fact.decision, status: "decided" },
    });
  }
  if (previous.status !== "decided" || previous.decision.id !== fact.id)
    return refuse("approval-unavailable");
  return accept({
    ...previous,
    status: "sending",
    decision: { ...previous.decision, status: "sending" },
  });
}

/** Settlement shares the execution entry's atomic append and is replayable. */
export function settleApprovals(
  state: ChannelState,
  matches: (request: ApprovalState) => boolean,
  reason: "process-ended" | "turn-ended" | "executor-replaced",
): Pick<ChannelState, "approvals" | "approvalRevision"> {
  const { approvals } = state;
  let next: Record<string, ApprovalState> | undefined;
  for (const [id, request] of Object.entries(approvals)) {
    if (request.status === "cleared" || request.status === "unavailable" || !matches(request))
      continue;
    next ??= { ...approvals };
    next[id] = { ...request, reason, status: reason === "turn-ended" ? "cleared" : "unavailable" };
  }
  return {
    approvals: next ?? approvals,
    approvalRevision: next ? state.seq + 1 : state.approvalRevision,
  };
}
