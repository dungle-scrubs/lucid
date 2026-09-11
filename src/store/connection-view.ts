import { ownerPresence, terminalPresence } from "../process-owner.js";
import type { NativeInterface } from "../protocol/connection.js";
import { nativeOwners } from "../protocol/connection.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import type { ChannelState } from "../protocol/reducer.js";
import { viewConversation } from "./conversation-host.js";
import type { DriverPreference } from "./driver-preference.js";
import { preferenceState } from "./driver-preference.js";

export interface ConnectionStatus {
  readonly message: string;
  readonly reason: string | null;
  readonly state:
    | "setup-required"
    | "not-listening"
    | "owner-unknown"
    | "owner-conflict"
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

/** This checkpoint observes binding ownership; listener and continuation states have separate slices. */
export function observeConnection(
  state: ChannelState,
  probe: (owner: ProcessOwner) => boolean | undefined = ownerPresence,
): ConnectionStatus {
  const binding = state.connection?.binding;
  let alive: boolean | undefined;
  if (binding) {
    try {
      alive = terminalPresence(nativeOwners(state), (owner) => (owner ? probe(owner) : undefined));
    } catch {
      /* Probe failure remains unknown. */
    }
  }
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
            reason: "listener-not-ready",
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
  return {
    ...observeConnection(state, deps.ownerPresence),
    actions: [],
    conversationId: state.conversationId,
    interface: binding?.interface ?? null,
    nativeSessionId: binding?.nativeSessionId ?? null,
    observedAt: (deps.now ?? Date.now)(),
    savedPreference: preferenceState(dir).preference,
  };
}
