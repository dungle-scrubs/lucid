import { nativeOwner } from "../../harness/native-owner.js";
import type { NativeListenerResult } from "../../modes/native-listener.js";
import type { NativeBinding } from "../../protocol/connection.js";
import type { ProcessOwner } from "../../protocol/process-owner.js";
import { sameProcessOwner } from "../../protocol/process-owner.js";
import type {
  NativeCapture,
  RegistrationAuthority,
  RegistrationFailure,
} from "../../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  registerNativeSession,
  withNativeRegistration,
} from "../../store/native-registration.js";
import { NATIVE_ROLE_ENV } from "../invocation.js";
import type { NativeStopOptions } from "../native-lifecycle.js";
import { interruptNativeListening, listenAtNativeStop } from "../native-lifecycle.js";
import type { Conversations } from "../record-addressing.js";

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

interface CodexHookOptions extends NativeStopOptions {
  readonly native?: CodexHookDeps;
}

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
  const authority = codexCallbackAuthority(captured.registration);
  return (payload as Record<string, unknown>).hook_event_name === "Interrupt"
    ? interruptNativeListening(records, captured.registration, authority)
    : listenAtNativeStop(records, captured.registration, authority, options);
}
