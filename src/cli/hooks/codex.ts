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

/** Stop can renew only the one completed delivery from this exact native lifecycle. */
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
  const candidates: string[] = [];
  try {
    const listing = records.list();
    if (listing.errors.length > 0)
      return {
        kind: "held",
        reason: "connection-unverified",
        message:
          "Lucid could not identify one conversation to continue. Feedback remains saved; run resume-listen for the intended conversation.",
      };
    for (const [id, dir] of listing.identities) {
      const connection = viewConversation(dir).state.connection;
      const listener = interrupted ? currentListener(connection) : continuationListener(connection);
      if (!sameNativeBinding(listener?.registration, captured.registration)) continue;
      candidates.push(id);
      if (candidates.length === 2) break;
    }
  } catch {
    return {
      kind: "held",
      reason: "connection-unverified",
      message: "Lucid could not read the connection evidence. Feedback remains saved.",
    };
  }
  if (candidates.length === 0) return { kind: "skipped" };
  const id = candidates[0];
  if (candidates.length !== 1 || !id)
    return {
      kind: "held",
      reason: "connection-conflict",
      message:
        "More than one conversation can continue in this session. Feedback remains saved; run resume-listen for the intended conversation.",
    };
  if (interrupted) {
    const authority = codexCallbackAuthority(captured.registration);
    const result = withNativeRegistration(
      records.rootDir,
      captured.registration.registrationId,
      (registration): NativeListenerResult | { readonly kind: "skipped" } => {
        const host = openWriter(commandRecordDir(records, id), {
          connectionAuthority: () => registration,
          expectedConversationId: id,
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
      },
      authority,
    );
    return result.ok
      ? result.value
      : { kind: "held", message: result.message, reason: result.reason };
  }
  return listenCodexFeedback(
    records,
    id,
    { output: "hook", signal: options.signal, source: "continuation" },
    {
      ...options.listener,
      authority: codexCallbackAuthority(captured.registration),
    },
  );
}
