/**
 * Owns the read-side liveness projection: the five conversation states
 * PLAN.md 4.6 enumerates, derived from channel state, the injected clock,
 * and presence. Heartbeat timeout (the lease clock) is the DECIDER; there
 * is deliberately no transport-close input at this seam - a closed socket
 * may reconnect in milliseconds and a half-open one looks alive, so the
 * host logs closes as hints and feeds nothing here. `presence` (the
 * normalizer's ps-level fact, injected so this module never imports it)
 * corroborates unattached vs gone on a DEAD channel only - it can never
 * prove a channel live. NOT responsible for enforcement: the reducer owns
 * every transition; this module only names the state the host acts on.
 */

import type { ChannelState } from "./reducer.js";
import { isLive, LEASE_RENEW_EVERY_MS, LEASE_TTL_MS } from "./reducer.js";

/** PLAN.md's liveness names for the lease clock - aliases, not a second
 * clock, so grace constants live in exactly one module (reducer.ts). */
export const HEARTBEAT_MS = LEASE_RENEW_EVERY_MS;
export const ATTACH_GRACE_MS = LEASE_TTL_MS;

/** The normalizer's ps-level fact, injected (M3.1 provides the real one;
 * tests fake it). */
export interface Presence {
  readonly processAlive: boolean;
}

export type ChannelStatus =
  | "interactive-attached"
  | "interactive-unattached"
  | "agent-gone"
  | "headless-session"
  | "headless-turn";

export const channelStatus = (
  state: ChannelState,
  now: number,
  presence: Presence,
): ChannelStatus => {
  if (isLive(state, now)) {
    const attachment = state.attachment;
    if (attachment === null) throw new Error("unreachable: live channel without attachment");
    switch (attachment.profile) {
      case "interactive":
        return "interactive-attached";
      case "headless-session":
        return "headless-session";
      case "headless-turn":
        return "headless-turn";
    }
  }
  return presence.processAlive ? "interactive-unattached" : "agent-gone";
};
