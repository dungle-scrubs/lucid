import { readProcessOwner } from "../process-owner.js";
import type {
  ConnectionFact,
  ListenerDisabledReason,
  ListenerParticipation,
} from "../protocol/connection.js";
import {
  currentReconnect,
  hasUnsettledNativeExecution,
  LISTENER_WAIT_MAX_MS,
  reconnectForListener,
  sameNativeBinding,
} from "../protocol/connection.js";
import type { ProtocolIssue } from "../protocol/frames.js";
import { createConversationHost, viewConversation } from "../store/conversation-host.js";
import { classifyStoreFailure, type StoreFailureCode } from "../store/errors.js";
import { LockError } from "../store/flock.js";
import {
  nativeInputCandidates,
  nativePreparationPrerequisite,
} from "../store/managed-readiness.js";
import type {
  NativeListenRequest,
  NativeRegistrationAccess,
  RegistrationAuthority,
  RegistrationFailure,
} from "../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  withNativeRegistration,
} from "../store/native-registration.js";
import { acquirePresence, type PresenceHandle } from "../store/presence.js";
import { DEFAULT_POLL_MS } from "../store/tailer.js";
import type { NativeFeedbackTransport, PreparedNativeFeedback } from "./native-preparation.js";
import { prepareNativeFeedback } from "./native-preparation.js";

interface NativeListenerOptions {
  readonly recordDir: string;
  readonly request?: NativeListenRequest;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly source: Extract<ConnectionFact, { kind: "listener-enabled" }>["source"];
  readonly transport: NativeFeedbackTransport;
}

export interface NativeListenerDeps {
  readonly authority: RegistrationAuthority;
  readonly now: () => number;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type NativeListenerResult =
  | { readonly kind: "offered"; readonly offerId: string; readonly payload: string }
  | {
      readonly kind: "stopped";
      /** Feedback this listen held, in order. Reported only when the listen expired. */
      readonly held?: readonly NativeHeldFeedback[];
      readonly reason: Exclude<ListenerDisabledReason, "owner-lost">;
    }
  | {
      readonly kind: "held";
      readonly message: string;
      readonly reason:
        | Extract<PreparedNativeFeedback, { kind: "held" }>["reason"]
        | ProtocolIssue
        | RegistrationFailure["reason"]
        | StoreFailureCode
        | "connection-setup-required"
        | "executor-busy"
        | "listener-failed";
    };

export interface NativeHeldFeedback {
  readonly inputId: string;
  readonly message: string;
}

export const heldNativeFeedback = (
  reason: Extract<NativeListenerResult, { kind: "held" }>["reason"],
  message: string,
): Extract<NativeListenerResult, { kind: "held" }> => ({
  kind: "held",
  message,
  reason,
});

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Native adapters supply a verified transport. Waiting owns no model process or registry lock. */
export async function listenNativeFeedback(
  options: NativeListenerOptions,
  overrides: Partial<NativeListenerDeps> = {},
): Promise<NativeListenerResult> {
  const deps: NativeListenerDeps = {
    authority: overrides.authority ?? nativeRegistrationAuthority(),
    now: overrides.now ?? Date.now,
    wait: overrides.wait ?? pause,
  };
  const { recordDir, request, root, signal, source, transport } = options;
  let lease: PresenceHandle | undefined;
  let host: ReturnType<typeof createConversationHost> | undefined;
  try {
    const before = viewConversation(recordDir).state;
    const checkRequest = (access: NativeRegistrationAccess): NativeListenerResult | null => {
      if (!request) return null;
      const current = access.readListenRequest();
      if (!current.ok) return heldNativeFeedback(current.reason, current.message);
      return current.value?.conversationId === before.conversationId &&
        request.conversationId === before.conversationId &&
        current.value.actionId === request.actionId
        ? null
        : heldNativeFeedback(
            "connection-not-admitted",
            "This listening request is no longer current. Feedback remains saved.",
          );
    };
    if (!before.connection)
      return heldNativeFeedback(
        "connection-setup-required",
        "Connect this conversation to its native author before listening.",
      );
    // Advisory precheck only. The host rechecks admission after acquiring presence.
    if (hasUnsettledNativeExecution(before))
      return heldNativeFeedback(
        "execution-blocked",
        "The previous delivery or execution must settle before listening again.",
      );
    const resolved = withNativeRegistration(
      root,
      undefined,
      (registration) => registration,
      deps.authority,
    );
    if (!resolved.ok) return heldNativeFeedback(resolved.reason, resolved.message);
    const registration = resolved.value;
    if (
      currentReconnect(before.connection) &&
      !reconnectForListener(before.connection, registration)
    )
      return heldNativeFeedback(
        "execution-blocked",
        "Reconnect is reserved for another native process. Saved feedback remains held.",
      );
    const executorOwner = readProcessOwner(process.pid);
    if (!executorOwner)
      return heldNativeFeedback("owner-unknown", "The listener process could not be verified.");
    host = createConversationHost(recordDir, {
      connectionAuthority: () => registration,
      executorLease: () => lease?.held() ?? false,
      now: deps.now,
      onEffect: () => {},
      onRecord: () => {},
      ownerPresence: deps.authority.ownerPresence,
      presence: () => undefined,
    });
    const writer = host;
    const participation: ListenerParticipation = {
      epoch: writer.state().epoch + 1,
      executorOwner,
      expiresAt: deps.now() + LISTENER_WAIT_MAX_MS,
      id: crypto.randomUUID(),
      registration,
    };
    const disable = (reason: ListenerDisabledReason): NativeListenerResult | null => {
      const result = writer.writeConnection({
        actionId: crypto.randomUUID(),
        epoch: participation.epoch,
        kind: "listener-disabled",
        participationId: participation.id,
        reason,
      });
      return result.verdict === "accepted"
        ? null
        : heldNativeFeedback(
            result.issue,
            "Listening ended, but its shutdown could not be recorded. Check connection status.",
          );
    };
    const write = (fact: ConnectionFact): NativeListenerResult | null => {
      const result = withNativeRegistration(
        root,
        registration.registrationId,
        (current, access) => {
          // The host's captured authority is valid only while this exact registry entry is locked.
          if (!sameNativeBinding(current, registration))
            return heldNativeFeedback(
              "stale-registration",
              "The native registration changed. Reconnect from the intended session.",
            );
          const requestIssue = checkRequest(access);
          if (requestIssue) return (lease?.held() ? disable("interrupted") : null) ?? requestIssue;
          if (fact.kind === "listener-enabled") {
            const admission = writer.acquireExecutor({ kind: "listener", fact }, () =>
              acquirePresence(recordDir, before.conversationId, { timeoutMs: 0 }),
            );
            if (admission.verdict === "refused")
              return heldNativeFeedback(
                admission.issue,
                "Listening was not admitted. Feedback remains saved.",
              );
            lease = admission.lease;
          }
          const result = writer.writeConnection(fact);
          return result.verdict === "accepted"
            ? null
            : heldNativeFeedback(
                result.issue,
                "The listener could not verify permission to deliver feedback. Check connection status.",
              );
        },
        deps.authority,
      );
      if (!result.ok) return heldNativeFeedback(result.reason, result.message);
      return result.value;
    };
    const enabled = write({
      actionId: source === "explicit" && request ? request.actionId : crypto.randomUUID(),
      kind: "listener-enabled",
      participation,
      source,
    });
    if (enabled) return enabled;
    const held: NativeHeldFeedback[] = [];
    while (!signal.aborted && deps.now() < participation.expiresAt) {
      const verified = withNativeRegistration(
        root,
        registration.registrationId,
        (_current, access) => checkRequest(access),
        deps.authority,
      );
      if (!verified.ok)
        return disable("owner-lost") ?? heldNativeFeedback(verified.reason, verified.message);
      const snapshot = viewConversation(recordDir);
      if (snapshot.state.connection?.listenerId !== participation.id) {
        return snapshot.state.connection?.disabledReason === "interrupted"
          ? { kind: "stopped", reason: "interrupted" }
          : heldNativeFeedback(
              "connection-not-admitted",
              "Listening was revoked. Feedback remains saved.",
            );
      }
      if (verified.value) return disable("interrupted") ?? verified.value;
      const inputId = nativeInputCandidates(recordDir, snapshot.state, snapshot.artifactHeads)[0];
      if (inputId !== undefined) {
        const prerequisite = nativePreparationPrerequisite(
          recordDir,
          snapshot.state,
          snapshot.artifactHeads,
        );
        const prepared = prepareNativeFeedback(writer, inputId, transport);
        if (signal.aborted || deps.now() >= participation.expiresAt) {
          if (prepared.kind === "ready") prepared.discard();
          break;
        }
        if (prepared.kind === "held") {
          held.push({ inputId, message: prepared.message });
          const refusal = write({
            actionId: crypto.randomUUID(),
            kind: "input-held",
            hold: {
              epoch: participation.epoch,
              inputId,
              message: prepared.message,
              participationId: participation.id,
              prerequisite,
              reason: prepared.reason,
            },
          });
          if (refusal) return refusal;
          continue;
        }
        let dispatched = false;
        try {
          const refusal = write(prepared.fact);
          if (refusal) return refusal;
          dispatched = true;
        } finally {
          if (!dispatched) prepared.discard();
        }
        return { kind: "offered", offerId: prepared.fact.offer.id, payload: prepared.payload };
      }
      await deps.wait(Math.min(DEFAULT_POLL_MS, participation.expiresAt - deps.now()), signal);
    }
    const reason = signal.aborted ? "interrupted" : "expired";
    return (
      disable(reason) ??
      (reason === "expired" && held.length > 0
        ? { held, kind: "stopped", reason }
        : { kind: "stopped", reason })
    );
  } catch (cause) {
    return heldNativeFeedback(
      cause instanceof LockError && cause.code === "lock-timeout"
        ? "executor-busy"
        : (classifyStoreFailure(cause) ?? "listener-failed"),
      "The listener could not continue. Feedback remains saved; check connection status before retrying.",
    );
  } finally {
    try {
      host?.close();
    } finally {
      lease?.release();
    }
  }
}
