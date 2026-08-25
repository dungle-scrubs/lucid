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

import type { ChannelState, Presence } from "./reducer.js";
import { isLive, LEASE_RENEW_EVERY_MS, LEASE_TTL_MS } from "./reducer.js";

export type { Presence } from "./reducer.js";

/** PLAN.md's liveness names for the lease clock - aliases, not a second
 * clock, so grace constants live in exactly one module (reducer.ts).
 * Because renewal is gated at renewEvery granularity, the real grace
 * after a writer's LAST frame lies in [ATTACH_GRACE_MS - HEARTBEAT_MS,
 * ATTACH_GRACE_MS]; hosts consult isLive/channelStatus, never arithmetic
 * on these. */
export const HEARTBEAT_MS = LEASE_RENEW_EVERY_MS;
export const ATTACH_GRACE_MS = LEASE_TTL_MS;

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
  if (!presence.processAlive) return "agent-gone";
  // A lapsed lease with the process still alive. Which profile was attached
  // still decides what this channel is.
  //
  // Collapsing every such case to `interactive-unattached` named the wrong
  // profile for a headless driver — and that name is load-bearing: it means
  // "a living human session, to be waited on, never taken over", and the
  // controller turns it into `await-reattach`. A headless driver sitting
  // idle is not going to re-attach; it is already attached and deliverable,
  // which is what the lock says and what its own follower does.
  const profile = state.attachment?.profile;
  if (profile === "headless-session") return "headless-session";
  if (profile === "headless-turn") return "headless-turn";
  return "interactive-unattached";
};
