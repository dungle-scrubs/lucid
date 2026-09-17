import type { NativeListenerDeps, NativeListenerResult } from "../modes/native-listener.js";
import type { NativeBinding } from "../protocol/connection.js";
import {
  continuationListener,
  currentListener,
  sameNativeBinding,
} from "../protocol/connection.js";
import { openWriter, viewConversation } from "../store/conversation-host.js";
import type { NativeListenRequest, RegistrationAuthority } from "../store/native-registration.js";
import { withNativeRegistration } from "../store/native-registration.js";
import { listenStopFeedback } from "./native-listening.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

export interface NativeStopOptions {
  readonly listener?: Pick<NativeListenerDeps, "now" | "wait">;
  readonly signal: AbortSignal;
}

type StopDecision =
  | NativeListenerResult
  | { readonly kind: "skipped" }
  | {
      readonly kind: "listen";
      readonly request: NativeListenRequest;
      readonly source: "explicit" | "continuation";
    };

/** Whether this registration holds a listening request. Unreadable state counts as present. */
export function hasNativeListenRequest(
  records: Conversations,
  registration: NativeBinding,
  authority: RegistrationAuthority,
): boolean {
  const result = withNativeRegistration(
    records.rootDir,
    registration.registrationId,
    (_current, access) => {
      const requested = access.readListenRequest();
      return !requested.ok || requested.value !== null;
    },
    authority,
  );
  return !result.ok || result.value;
}

/** Interrupt clears the exact listening request and revokes its current listener. */
export function interruptNativeListening(
  records: Conversations,
  registration: NativeBinding,
  authority: RegistrationAuthority,
): NativeListenerResult | { readonly kind: "skipped" } {
  const result = withNativeRegistration(
    records.rootDir,
    registration.registrationId,
    (current, access): NativeListenerResult | { readonly kind: "skipped" } => {
      const requested = access.readListenRequest();
      if (!requested.ok)
        return { kind: "held", reason: requested.reason, message: requested.message };
      const request = requested.value;
      if (!request) return { kind: "skipped" };
      // Clear pending intent before looking up the record: a missing record must
      // not leave a request that restarts on a later unrelated turn.
      const cleared = access.writeListenRequest(null);
      if (!cleared.ok) return { kind: "held", reason: cleared.reason, message: cleared.message };
      const host = openWriter(commandRecordDir(records, request.conversationId), {
        connectionAuthority: () => current,
        expectedConversationId: request.conversationId,
        ownerPresence: authority.ownerPresence,
      });
      try {
        const listener = currentListener(host.state().connection);
        if (!listener || !sameNativeBinding(listener.registration, current))
          return { kind: "skipped" };
        const written = host.writeConnection({
          actionId: crypto.randomUUID(),
          epoch: listener.epoch,
          kind: "listener-disabled",
          participationId: listener.id,
          reason: "interrupted",
        });
        return written.verdict === "accepted"
          ? { kind: "stopped", reason: "interrupted" }
          : {
              kind: "held",
              reason: written.issue,
              message:
                "Lucid could not record the native interruption. Check connection status before resuming.",
            };
      } finally {
        host.close();
      }
    },
    authority,
  );
  return result.ok
    ? result.value
    : { kind: "held", reason: result.reason, message: result.message };
}

/** Stop consumes one exact request, then continues only matching completed deliveries. */
export async function listenAtNativeStop(
  records: Conversations,
  registration: NativeBinding,
  authority: RegistrationAuthority,
  options: NativeStopOptions,
): Promise<NativeListenerResult | { readonly kind: "skipped" }> {
  const selected = withNativeRegistration(
    records.rootDir,
    registration.registrationId,
    (current, access): StopDecision => {
      const requested = access.readListenRequest();
      if (!requested.ok)
        return { kind: "held", reason: requested.reason, message: requested.message };
      const request = requested.value;
      if (!request) return { kind: "skipped" };
      const connection = viewConversation(commandRecordDir(records, request.conversationId)).state
        .connection;
      if (!connection) return { kind: "skipped" };
      if (!Object.hasOwn(connection.actions, request.actionId))
        return { kind: "listen", request, source: "explicit" };
      const listener = continuationListener(connection);
      return sameNativeBinding(listener?.registration, current)
        ? { kind: "listen", request, source: "continuation" }
        : { kind: "skipped" };
    },
    authority,
  );
  if (!selected.ok) return { kind: "held", reason: selected.reason, message: selected.message };
  if (selected.value.kind !== "listen") return selected.value;
  return listenStopFeedback(
    records,
    selected.value.request.conversationId,
    { request: selected.value.request, signal: options.signal, source: selected.value.source },
    { ...options.listener, authority },
  );
}
