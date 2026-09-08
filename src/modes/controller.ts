/**
 * The conversation controller: the state machine that maps a channel's
 * current status (PLAN 4.6) to the ONE action the host layer should take
 * for it. Pure - status in, action out - so mode selection is testable
 * without a live harness. It decides POLICY; the store enforces every
 * transition and the sources carry it out. The takeover flag encodes the
 * load-bearing rule that a living-but-unattached human process is waited
 * on, never taken over (presence holds - D-021), while a gone process is
 * headless-takeover territory.
 */

import type { ChannelStatus } from "../protocol/index.js";

export type ControllerActionKind =
  /** Live channel: deliver input through it and render output. */
  | "deliver"
  /** headless-turn: a turn in flight is never interjected; queued input
   * lands at the next turn boundary. */
  | "deliver-at-boundary"
  /** interactive-unattached: no pipe. Wait for an authenticated re-attach
   * (epoch++) or surface a resume instruction. Never wake directly. */
  | "await-reattach"
  /** agent-gone: open a headless session/turn resuming the native id. */
  | "headless-takeover";

export interface ControllerAction {
  readonly action: ControllerActionKind;
  /** Whether this action seizes the conversation from a prior writer. Only
   * ever true for agent-gone: a living-but-unattached human is waited on,
   * never taken over (presence holds - D-021). */
  readonly takeover: boolean;
}

export const decideAction = (status: ChannelStatus): ControllerAction => {
  switch (status) {
    case "interactive-attached":
    case "headless-session":
      return { action: "deliver", takeover: false };
    case "headless-turn":
      return { action: "deliver-at-boundary", takeover: false };
    case "interactive-unattached":
      return { action: "await-reattach", takeover: false };
    case "agent-gone":
      return { action: "headless-takeover", takeover: true };
  }
};
