import type { ProtocolIssue } from "./frames.js";
import type { ChannelState, ReduceResult } from "./reducer.js";

export function refuseExecution(
  state: ChannelState,
  now: number,
  issue: ProtocolIssue,
): ReduceResult {
  return {
    verdict: "refused",
    issue,
    state,
    effects: [],
    record: {
      verdict: "refused",
      kind: "input",
      conversationId: state.conversationId,
      epoch: state.epoch,
      issue,
      now,
    },
  };
}
