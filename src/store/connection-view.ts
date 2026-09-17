import type {
  ConnectionAction,
  ConnectionProjection,
  ConnectionStatus,
} from "../protocol/connection-status.js";

export type {
  ConnectionAction,
  ConnectionProjection,
  ConnectionStatus,
} from "../protocol/connection-status.js";

import { ownerPresence } from "../process-owner.js";
import {
  awaitingNativeBinding,
  currentListener,
  currentReconnect,
  hasUncertainReconnect,
  hasUnsettledLaunch,
  isUnsettledLaunch,
  nativeOwners,
  requiresNativeConnection,
} from "../protocol/connection.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import { sameProcessOwner } from "../protocol/process-owner.js";
import type { ChannelState } from "../protocol/reducer.js";
import { viewConversation } from "./conversation-host.js";
import { preferenceState } from "./driver-preference.js";
import { nativeInputViews } from "./native-input-view.js";
import { presenceHeld } from "./presence.js";

const OWNER_CONFLICT = connectionFailure(
  "native-identity-conflict",
  "More than one native session owner is open. Connection is held until ownership is resolved.",
);

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
  if (!binding && state.nativePublication) {
    const failure = state.nativePublication.failure;
    const delivery = state.nativePublication.legacyDelivery;
    const history = failure ? ` Last connection attempt: ${failure.message}` : "";
    if (delivery.uncertainInputs.length)
      return {
        message:
          "An earlier input has no confirmed receipt. Saved feedback remains held; process exit does not confirm delivery." +
          history,
        reason: "delivery-uncertain",
        state: "delivery-uncertain",
      };
    if (delivery.inFlight > 0)
      return {
        message:
          "An earlier response has no confirmed outcome. Saved feedback remains held until that response finishes with recorded evidence." +
          history,
        reason: "execution-outcome-unverified",
        state: "outcome-unknown",
      };
    return {
      message: failure
        ? "Last connection attempt: " +
          failure.message +
          " Saved feedback remains held until a native connection is verified."
        : "Native publication or connection did not finish. Saved feedback remains held until a native connection is verified.",
      reason: failure?.reason ?? "publication-connection-incomplete",
      state: "setup-required",
    };
  }
  let alive: boolean | undefined;
  let conflict = false;
  const observations = nativeOwners(state).map(({ owner }) => {
    let present: boolean | undefined;
    try {
      present = owner ? probe(owner) : undefined;
    } catch {
      /* Failed ownership inspection remains unknown. */
    }
    return { owner, present };
  });
  const present = (owner: ProcessOwner | undefined): boolean | undefined => {
    if (!owner) return undefined;
    const observed = observations.find((entry) => sameProcessOwner(entry.owner, owner));
    if (observed) return observed.present;
    let value: boolean | undefined;
    try {
      value = probe(owner);
    } catch {
      /* Listener process inspection follows the same unknown rule. */
    }
    observations.push({ owner, present: value });
    return value;
  };
  if (binding) {
    const values = observations.map((entry) => entry.present);
    conflict = values.filter((value) => value === true).length > 1;
    alive = values.includes(undefined) || conflict ? undefined : values.includes(true);
  }
  if (hasUnsettledLaunch(state.connection)) {
    if (observations.some((entry) => entry.present === true))
      return {
        message:
          "An interactive owner is open while a same-session launch is unsettled. Resolve ownership and launch outcome before continuing.",
        reason: "native-identity-conflict",
        state: "owner-conflict",
      };
    const launches = Object.values(state.connection?.launches ?? {}).filter(isUnsettledLaunch);
    const pending = launches.length === 1 ? launches[0] : undefined;
    const attempt = pending && state.executions[pending.launch.inputId];
    const interactiveOwnersGone = observations.every((entry) => entry.present === false);
    const requester = pending ? present(pending.launch.requester) : false;
    if (!interactiveOwnersGone || requester === undefined || executorPresent === undefined)
      return {
        message:
          "Lucid cannot verify the owners or executor lock for this headless launch. Saved feedback remains held.",
        reason: !interactiveOwnersGone
          ? "owner-unknown"
          : requester === undefined
            ? "headless-owner-unverified"
            : "executor-unverified",
        state: "owner-unknown",
      };
    if (
      pending &&
      attempt?.kind === "attempt-started" &&
      pending.launch.execution?.turnId === attempt.turnId &&
      pending.launch.execution.attempt === attempt.attempt &&
      pending.launch.epoch === state.epoch &&
      requester === true &&
      executorPresent === true
    ) {
      if (state.completedTurns[attempt.turnId] !== undefined)
        return {
          message:
            "The response ended. Waiting for its process to finish cleanup before continuing.",
          reason: null,
          state: "cleanup",
        };
      return pending.kind === "started"
        ? {
            message: "The same native session is responding headlessly.",
            reason: null,
            state: "headless-running",
          }
        : {
            message: "Resuming the same native session headlessly.",
            reason: null,
            state: "headless-starting",
          };
    }
    return {
      message:
        "A same-session launch was admitted, but process creation and cleanup are not settled. Saved feedback will not be sent again automatically.",
      reason: "launch-unsettled",
      state: "launch-uncertain",
    };
  }
  const uncertain = Object.values(state.connection?.launches ?? {}).find(
    (entry) => entry.kind === "settled" && entry.outcome.kind === "uncertain",
  );
  if (uncertain?.kind === "settled")
    return {
      message:
        "The headless process ended, but its response outcome could not be confirmed. Saved feedback will not be sent again automatically.",
      reason: "execution-outcome-unverified",
      state: "outcome-unknown",
    };
  const reconnect = currentReconnect(state.connection);
  if (reconnect?.kind === "intended" && conflict) return OWNER_CONFLICT;
  if (hasUncertainReconnect(state.connection))
    return {
      message:
        "Lucid could not verify the final reconnect result and native process cleanup. Saved feedback is held; reconnect will not be retried automatically.",
      reason: "reconnect-result-unverified",
      state: "launch-uncertain",
    };
  if (reconnect?.kind === "intended" && reconnect.completion)
    return reconnect.completion.result.kind === "refused"
      ? {
          message: `${
            reconnect.completion.result.reason === "invalid-request"
              ? "The reconnect request or startup instruction is invalid. Check the Lucid startup configuration."
              : reconnect.completion.result.reason === "unsupported-interface"
                ? "This interface does not support interactive startup through HCN. Check its setup instructions."
                : "Reconnect did not start a native session."
          } Saved feedback and the reconnect request remain held.`,
          reason: "reconnect-refused",
          state: "resume-failed",
        }
      : {
          message:
            "The interactive session ended before its listener connected. Process cleanup is complete. Saved feedback and the reconnect request remain held.",
          reason: "reconnect-closed",
          state: "resume-failed",
        };
  if (reconnect?.kind === "intended" && reconnect.started && !conflict) {
    const child = present(reconnect.started.owner);
    if (child !== undefined && observations.some((entry) => entry.present === undefined))
      return {
        message:
          "Lucid cannot confirm whether another interactive session is still open. Reconnect and saved feedback remain held.",
        reason: "reconnect-owner-unverified",
        state: "owner-unknown",
      };
    if (child === true)
      return {
        message:
          "The interactive session started. Waiting for it to connect and listen. Saved feedback is held.",
        reason: "reconnect-listener-pending",
        state: "reconnect-waiting",
      };
    if (child === undefined)
      return {
        message:
          "The interactive session started, but its process cannot be verified. Saved feedback is held.",
        reason: "reconnect-child-unverified",
        state: "owner-unknown",
      };
  }
  if (reconnect?.kind === "intended")
    return {
      message:
        "Interactive reconnect was admitted, but native process creation is not verified. Saved feedback is held.",
      reason: "reconnect-launch-unverified",
      state: "launch-uncertain",
    };
  const pending = Object.values(state.connection?.offers ?? {}).find(
    (offer) => offer.kind !== "finished",
  );
  const pendingOwner = pending
    ? state.connection?.participations[pending.offer.participationId]?.registration.owner
    : undefined;
  if (pending?.kind === "sending")
    return alive === true && present(pendingOwner) === true
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
    return alive === true && present(pendingOwner) === true
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
  if (conflict) return OWNER_CONFLICT;
  if (alive === false && currentReconnect(state.connection))
    return {
      message: "Waiting to reconnect to the same native session. Saved feedback is held.",
      reason: "reconnect-pending",
      state: "reconnect-waiting",
    };
  if (
    alive === true &&
    !state.connection?.disabledReason &&
    listener &&
    present(listener.registration.owner) === true &&
    listener.epoch === state.epoch &&
    listener.expiresAt > now
  ) {
    const listenerPresent = present(listener.executorOwner);
    if (listenerPresent === undefined)
      return {
        message: "The interactive session is open, but Lucid cannot verify its listener process.",
        reason: "listener-process-unverified",
        state: "owner-unknown",
      };
    if (!listenerPresent)
      return {
        message: "Your interactive session is still open. Tell it to resume listening.",
        reason: "listener-process-gone",
        state: "not-listening",
      };
    if (executorPresent === undefined)
      return {
        message: "The interactive session is open, but Lucid cannot verify its listener lock.",
        reason: "executor-unverified",
        state: "owner-unknown",
      };
    if (executorPresent)
      return {
        message: "Interactive session connected and listening.",
        reason: null,
        state: "listening",
      };
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
  const { state, transcript } = viewConversation(dir);
  const binding = state.connection?.binding;
  const observedAt = (deps.now ?? Date.now)();
  const status = observeConnection(state, {
    executorPresent:
      currentListener(state.connection) || hasUnsettledLaunch(state.connection)
        ? presenceHeld(dir)
        : false,
    now: observedAt,
    ownerPresence: deps.ownerPresence ?? ownerPresence,
  });
  return {
    ...status,
    actions: connectionActions(status, state),
    conversationId: state.conversationId,
    inputs: nativeInputViews(state, transcript, status),
    interface: binding?.interface ?? null,
    nativeConnectionRequired: requiresNativeConnection(state),
    nativeSessionId: binding?.nativeSessionId ?? null,
    observedAt,
    savedPreference: preferenceState(dir).preference,
  };
}

function connectionActions(
  status: ConnectionStatus,
  state: ChannelState,
): readonly ConnectionAction[] {
  if (awaitingNativeBinding(state))
    return status.state === "setup-required" ? ["setup-instructions"] : [];
  if (status.state === "owner-unknown" || status.state === "owner-conflict")
    return ["retry-detection"];
  const nativeInterface = state.connection?.binding.interface;
  if (nativeInterface !== "codex-cli" && nativeInterface !== "claude-cli") return [];
  if (status.state === "not-listening") return ["resume-listening-instructions"];
  // Claude Code has no protected reconnect yet; the person resumes the session, then listens.
  if (nativeInterface === "claude-cli" && status.state === "closed")
    return ["resume-listening-instructions"];
  if (
    // Terminal reconnect and headless continuation are verified for Codex CLI only.
    nativeInterface === "codex-cli" &&
    !currentReconnect(state.connection) &&
    ["closed", "headless-starting", "headless-running", "cleanup"].includes(status.state)
  )
    return ["reconnect-instructions"];
  if (status.state === "setup-required" || status.state === "resume-failed")
    return ["setup-instructions"];
  return [];
}
