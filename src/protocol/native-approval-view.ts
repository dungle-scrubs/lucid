import type { ApprovalState } from "./native-approvals.js";
import type { ChannelState } from "./reducer.js";

export function approvalView(entry: ApprovalState, driving: boolean | undefined): ApprovalState {
  return entry.status === "cleared" || entry.status === "unavailable" || driving === true
    ? entry
    : {
        ...entry,
        status: "unavailable",
        reason: driving === false ? "process-ended" : "process-unverified",
      };
}

/** Read-only: process evidence can remove controls, never dispatch a decision. */
export function approvalViews(
  state: ChannelState,
  driving: boolean | undefined,
): readonly ApprovalState[] {
  return Object.values(state.approvals)
    .sort((left, right) => left.seq - right.seq)
    .map((entry) => approvalView(entry, driving));
}
