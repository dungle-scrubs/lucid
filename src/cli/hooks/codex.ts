import { nativeOwner } from "../../harness/native-owner.js";
import type { NativeListenerDeps, NativeListenerResult } from "../../modes/native-listener.js";
import type { NativeBinding } from "../../protocol/connection.js";
import {
  continuationListener,
  currentListener,
  sameNativeBinding,
} from "../../protocol/connection.js";
import type { ProcessOwner } from "../../protocol/process-owner.js";
import { sameProcessOwner } from "../../protocol/process-owner.js";
import { openWriter, viewConversation } from "../../store/conversation-host.js";
import type {
  NativeCapture,
  NativeListenRequest,
  RegistrationAuthority,
  RegistrationFailure,
} from "../../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  registerNativeSession,
  withNativeRegistration,
} from "../../store/native-registration.js";
import { listenCodexFeedback } from "../codex-listener.js";
import { NATIVE_ROLE_ENV } from "../invocation.js";
import type { Conversations } from "../record-addressing.js";
import { commandRecordDir } from "../record-addressing.js";

export interface CodexHookDeps {
  readonly owner: () => Promise<ProcessOwner | undefined>;
  readonly role: string | undefined;
}

export type CodexRegistrationResult =
  | { readonly ok: true; readonly registration: NativeBinding }
  | { readonly ok: true; readonly skipped: true }
  | RegistrationFailure;

export async function captureCodexAuthor(
  root: string,
  payload: unknown,
  deps: CodexHookDeps = { owner: () => nativeOwner("codex"), role: process.env[NATIVE_ROLE_ENV] },
): Promise<CodexRegistrationResult> {
  if (deps.role !== undefined) return { ok: true, skipped: true };
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return {
      ok: false,
      reason: "invalid-registration",
      message: "The Codex hook payload is invalid.",
    };
  const input = payload as Record<string, unknown>;
  // Codex emits SubagentStart/SubagentStop instead of parent lifecycle events.
  // Verified in core/src/hook_runtime.rs at openai/codex 944d6fd1ba4baab69dbedd205282dc72ec20abb5
  // and the isolated native lane. Agent markers also reject mislabeled parent events.
  if (input.agent_id !== undefined || input.agent_type !== undefined)
    return { ok: true, skipped: true };
  // The same native source excludes subagents from run_turn_interrupt_hooks.
  if (
    input.hook_event_name !== "Stop" &&
    input.hook_event_name !== "Interrupt" &&
    input.hook_event_name !== "SessionStart"
  )
    return { ok: true, skipped: true };
  // https://learn.chatgpt.com/docs/hooks#sessionstart: compact preserves the lifecycle.
  if (input.hook_event_name === "SessionStart" && input.source === "compact")
    return { ok: true, skipped: true };
  if (
    input.hook_event_name === "SessionStart" &&
    (typeof input.source !== "string" ||
      !["startup", "resume", "clear", "fork"].includes(input.source))
  )
    return {
      ok: false,
      reason: "invalid-registration",
      message:
        "This Codex SessionStart source is unsupported. Restart or resume the native session before connecting Lucid.",
    };
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string")
    return {
      ok: false,
      reason: "invalid-registration",
      message: "The Codex callback has no session identity or working folder.",
    };
  let owner: ProcessOwner | undefined;
  try {
    owner = await deps.owner();
  } catch {
    // A failed native inspection cannot establish process ownership.
  }
  if (!owner)
    return {
      ok: false,
      reason: "owner-unknown",
      message: "The Codex native process could not be verified.",
    };
  const capture = {
    harness: "codex" as const,
    interface: "codex-cli" as const,
    nativeSessionId: input.session_id,
    owner,
    workingDirectory: input.cwd,
  };
  const authority = codexCallbackAuthority(capture);
  if (input.hook_event_name === "SessionStart")
    return registerNativeSession(root, capture, authority);
  const current = withNativeRegistration(
    root,
    undefined,
    (registration) => registration,
    authority,
  );
  return current.ok ? { ok: true, registration: current.value } : current;
}

/** Only use after capturing a parent callback and corroborating its native owner. */
export function codexCallbackAuthority(capture: NativeCapture): RegistrationAuthority {
  return nativeRegistrationAuthority(
    (candidate) =>
      candidate.harness === capture.harness &&
      candidate.interface === capture.interface &&
      candidate.nativeSessionId === capture.nativeSessionId &&
      candidate.workingDirectory === capture.workingDirectory &&
      sameProcessOwner(candidate.owner, capture.owner),
  );
}

interface CodexHookOptions {
  readonly signal: AbortSignal;
  readonly native?: CodexHookDeps;
  readonly listener?: Pick<NativeListenerDeps, "now" | "wait">;
}

type HookDecision =
  | NativeListenerResult
  | { readonly kind: "skipped" }
  | {
      readonly kind: "listen";
      readonly request: NativeListenRequest;
      readonly source: "explicit" | "continuation";
    };

/** Stop consumes one exact request, then continues only matching completed deliveries. */
export async function runCodexHook(
  records: Conversations,
  payload: unknown,
  options: CodexHookOptions,
): Promise<NativeListenerResult | { readonly kind: "skipped" }> {
  const captured = await captureCodexAuthor(records.rootDir, payload, options.native);
  if (!captured.ok) return { kind: "held", message: captured.message, reason: captured.reason };
  if (
    "skipped" in captured ||
    (payload as Record<string, unknown>).hook_event_name === "SessionStart"
  )
    return { kind: "skipped" };
  const interrupted = (payload as Record<string, unknown>).hook_event_name === "Interrupt";
  const authority = codexCallbackAuthority(captured.registration);
  const selected = withNativeRegistration(
    records.rootDir,
    captured.registration.registrationId,
    (registration, access): HookDecision => {
      const requested = access.readListenRequest();
      if (!requested.ok)
        return { kind: "held", reason: requested.reason, message: requested.message };
      const request = requested.value;
      if (!request) return { kind: "skipped" };
      if (interrupted) {
        // Clear pending intent before looking up the record: a missing record must
        // not leave a request that restarts on a later unrelated turn.
        const cleared = access.writeListenRequest(null);
        if (!cleared.ok) return { kind: "held", reason: cleared.reason, message: cleared.message };
        const host = openWriter(commandRecordDir(records, request.conversationId), {
          connectionAuthority: () => registration,
          expectedConversationId: request.conversationId,
          ownerPresence: authority.ownerPresence,
        });
        try {
          const listener = currentListener(host.state().connection);
          if (!listener || !sameNativeBinding(listener.registration, registration))
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
      }
      const connection = viewConversation(commandRecordDir(records, request.conversationId)).state
        .connection;
      if (!connection) return { kind: "skipped" };
      if (!Object.hasOwn(connection.actions, request.actionId))
        return { kind: "listen", request, source: "explicit" };
      const listener = continuationListener(connection);
      return sameNativeBinding(listener?.registration, registration)
        ? { kind: "listen", request, source: "continuation" }
        : { kind: "skipped" };
    },
    authority,
  );
  if (!selected.ok) return { kind: "held", reason: selected.reason, message: selected.message };
  if (selected.value.kind !== "listen") return selected.value;
  return listenCodexFeedback(
    records,
    selected.value.request.conversationId,
    { request: selected.value.request, signal: options.signal, source: selected.value.source },
    {
      ...options.listener,
      authority,
    },
  );
}
