import { ownerPresence } from "../process-owner.js";
import type { NativeInterface } from "../protocol/connection.js";
import { currentListener, nativeOwners } from "../protocol/connection.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import type { ChannelState } from "../protocol/reducer.js";
import { viewConversation } from "./conversation-host.js";
import type { DriverPreference } from "./driver-preference.js";
import { preferenceState } from "./driver-preference.js";
import { presenceHeld } from "./presence.js";

export interface ConnectionStatus {
  readonly message: string;
  readonly reason: string | null;
  readonly state:
    | "setup-required"
    | "listening"
    | "not-listening"
    | "owner-unknown"
    | "owner-conflict"
    | "delivery-uncertain"
    | "outcome-unknown"
    | "closed";
}

export interface ConnectionProjection extends ConnectionStatus {
  readonly actions: readonly string[];
  readonly conversationId: string;
  readonly interface: NativeInterface | null;
  readonly nativeSessionId: string | null;
  readonly observedAt: number;
  readonly savedPreference: DriverPreference | null;
}

export function connectionFailure(reason: string, message: string): ConnectionStatus {
  return {
    message,
    reason,
    state:
      reason === "owner-unknown" || reason === "connection-unverified"
        ? "owner-unknown"
        : reason === "native-identity-conflict" || reason === "connection-conflict"
          ? "owner-conflict"
          : "setup-required",
  };
}

/** Every owner is observed once per read. A live owner cannot conceal a failed probe. */
export function observeConnection(
  state: ChannelState,
  observation: {
    readonly executorPresent: boolean | undefined;
    readonly now: number;
    readonly ownerPresence: (owner: ProcessOwner) => boolean | undefined;
  },
): ConnectionStatus {
  const { executorPresent, now, ownerPresence: probe } = observation;
  const binding = state.connection?.binding;
  let alive: boolean | undefined;
  let conflict = false;
  if (binding) {
    const observations = nativeOwners(state).map(({ owner }) => {
      try {
        return owner ? probe(owner) : undefined;
      } catch {
        return undefined;
      }
    });
    conflict = observations.filter((value) => value === true).length > 1;
    alive = observations.includes(undefined) || conflict ? undefined : observations.includes(true);
  }
  const pending = Object.values(state.connection?.offers ?? {}).find(
    (offer) => offer.kind !== "finished",
  );
  if (pending?.kind === "sending")
    return alive === true
      ? {
          message: "Sending feedback. Waiting for the interactive session to confirm receipt.",
          reason: null,
          state: "not-listening",
        }
      : {
          message:
            "Feedback was offered, but receipt was not confirmed. It will not be sent again automatically.",
          reason: "delivery-uncertain",
          state: "delivery-uncertain",
        };
  if (pending?.kind === "received")
    return alive === true
      ? {
          message: "Feedback received. Waiting for the interactive session to record its response.",
          reason: null,
          state: "not-listening",
        }
      : {
          message:
            "The session confirmed receipt, but its response outcome is unknown. Feedback will not be sent again automatically.",
          reason: "outcome-unknown",
          state: "outcome-unknown",
        };
  const listener = currentListener(state.connection);
  if (conflict)
    return {
      message:
        "More than one native session owner is open. Connection is held until ownership is resolved.",
      reason: "native-identity-conflict",
      state: "owner-conflict",
    };
  if (
    alive === true &&
    !state.connection?.disabledReason &&
    listener &&
    listener.epoch === state.epoch &&
    listener.expiresAt > now &&
    executorPresent === true
  )
    return {
      message: "Interactive session connected and listening.",
      reason: null,
      state: "listening",
    };
  return !binding
    ? {
        message:
          "Artifact published; connection needs setup. Interactive mode needs a connected session.",
        reason: "registration-missing",
        state: "setup-required",
      }
    : alive === undefined
      ? {
          message:
            "Cannot confirm whether the interactive session is open. Its process identity could not be verified.",
          reason: "owner-unknown",
          state: "owner-unknown",
        }
      : alive
        ? {
            message: "Your interactive session is still open. Tell it to resume listening.",
            reason: state.connection?.disabledReason
              ? "listener-disabled"
              : listener && listener.expiresAt <= now
                ? "listener-expired"
                : "listener-not-ready",
            state: "not-listening",
          }
        : {
            message:
              "No interactive session detected. Saved feedback remains in this conversation.",
            reason: null,
            state: "closed",
          };
}

/** Ownership is observed afresh; neither a saved preference nor registration proves readiness. */
export function readConnection(
  dir: string,
  deps: {
    readonly now?: () => number;
    readonly ownerPresence?: (owner: ProcessOwner) => boolean | undefined;
  } = {},
): ConnectionProjection {
  const { state } = viewConversation(dir);
  const binding = state.connection?.binding;
  const observedAt = (deps.now ?? Date.now)();
  return {
    ...observeConnection(state, {
      executorPresent: currentListener(state.connection) ? presenceHeld(dir) : false,
      now: observedAt,
      ownerPresence: deps.ownerPresence ?? ownerPresence,
    }),
    actions: [],
    conversationId: state.conversationId,
    interface: binding?.interface ?? null,
    nativeSessionId: binding?.nativeSessionId ?? null,
    observedAt,
    savedPreference: preferenceState(dir).preference,
  };
}
