/**
 * Shared protocol test helpers: the canonical frame builders and the
 * narrow-or-throw verdict helpers, so the attach/event wire shapes are
 * spelled exactly once across the protocol suites.
 */

import type { Frame } from "../../src/protocol/frames.js";
import {
  type ChannelState,
  initialChannelState,
  PROTOCOL_VERSION,
  type ReduceResult,
  reduce,
} from "../../src/protocol/reducer.js";

export const SECRET = "s3cret";

export const fresh = (): ChannelState =>
  initialChannelState({ conversationId: "conv-1", secret: SECRET });

export const attach = (overrides: Partial<Extract<Frame, { kind: "attach" }>> = {}): Frame => ({
  kind: "attach",
  conversationId: "conv-1",
  profile: "interactive",
  secret: SECRET,
  version: PROTOCOL_VERSION,
  ...overrides,
});

// Default payload is LOSSLESS (message): most tests exercise fencing and
// sequencing, not flow control - droppable payloads are credit-gated and
// named explicitly in the credit tests.
export const event = (overrides: Partial<Extract<Frame, { kind: "event" }>> = {}): Frame => ({
  kind: "event",
  epoch: 1,
  n: 1,
  turnId: "t-1",
  event: { kind: "message", text: "x" },
  ...overrides,
});

export const expectAccepted = (
  result: ReduceResult,
): Extract<ReduceResult, { verdict: "accepted" }> => {
  if (result.verdict !== "accepted")
    throw new Error(`expected accepted, got refusal: ${result.issue}`);
  return result;
};

export const expectRefused = (
  result: ReduceResult,
): Extract<ReduceResult, { verdict: "refused" }> => {
  if (result.verdict !== "refused") throw new Error("expected refusal, got accepted");
  return result;
};

/** Drive a sequence of accepted frames and return the final state. */
export const drive = (
  state: ChannelState,
  frames: readonly (readonly [Frame, number])[],
): ChannelState =>
  frames.reduce((current, [frame, at]) => expectAccepted(reduce(current, frame, at)).state, state);
