import { nativeOwner } from "../../harness/native-owner.js";
import type { NativeListenerResult } from "../../modes/native-listener.js";
import type { ConnectionControl, NativeBinding } from "../../protocol/connection.js";
import type { ProcessOwner } from "../../protocol/process-owner.js";
import { sameProcessOwner } from "../../protocol/process-owner.js";
import type { ClaudeOperation } from "../../store/claude-proposals.js";
import {
  CLAUDE_PROPOSAL_MARKER,
  claimClaudeProposal,
  proposalNonces,
  readStopBlocks,
  writeStopBlocks,
} from "../../store/claude-proposals.js";
import type {
  RegistrationAuthority,
  RegistrationFailure,
} from "../../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  registerNativeSession,
  withNativeRegistration,
} from "../../store/native-registration.js";
import { connectPublication, refusePublicationConnection } from "../artifact-publish.js";
import { claudeSessionAuthority } from "../claude-commands.js";
import { runConnectionControl } from "../connection-control.js";
import { NATIVE_ROLE_ENV } from "../invocation.js";
import type { NativeStopOptions } from "../native-lifecycle.js";
import {
  hasNativeListenRequest,
  interruptNativeListening,
  listenAtNativeStop,
} from "../native-lifecycle.js";
import { requestNativeListening } from "../native-listening.js";
import type { Conversations } from "../record-addressing.js";

export interface ClaudeHookDeps {
  /** Claude Code's consecutive Stop-continuation cap; 0 disables it. */
  readonly blockCap: number;
  readonly owner: () => Promise<ProcessOwner | undefined>;
  readonly role: string | undefined;
}

// https://code.claude.com/docs/en/env-vars: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, default 8.
const DEFAULT_BLOCK_CAP = 8;

export function claudeBlockCap(value: string | undefined): number {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : DEFAULT_BLOCK_CAP;
}

const defaultDeps = (): ClaudeHookDeps => ({
  blockCap: claudeBlockCap(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP),
  owner: () => nativeOwner("claude"),
  role: process.env[NATIVE_ROLE_ENV],
});

export type ClaudeRegistrationResult =
  | { readonly ok: true; readonly registration: NativeBinding }
  | { readonly ok: true; readonly skipped: true }
  | RegistrationFailure;

type Payload = Record<string, unknown>;
const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"]);

/** Resolve the parent Claude session a lifecycle callback belongs to. */
export async function captureClaudeAuthor(
  root: string,
  payload: unknown,
  deps: ClaudeHookDeps = defaultDeps(),
): Promise<ClaudeRegistrationResult> {
  if (deps.role !== undefined) return { ok: true, skipped: true };
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return {
      ok: false,
      reason: "invalid-registration",
      message: "The Claude Code hook payload is invalid.",
    };
  const input = payload as Payload;
  // https://code.claude.com/docs/en/hooks#common-input-fields: agent_id is present only inside a
  // subagent. The isolated Claude Code 2.1.274 lane observed it on subagent tool callbacks that
  // carried the parent's session ID and process. SubagentStart/SubagentStop are separate events.
  if (input.agent_id !== undefined || typeof input.hook_event_name !== "string")
    return { ok: true, skipped: true };
  if (!EVENTS.has(input.hook_event_name)) return { ok: true, skipped: true };
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string")
    return {
      ok: false,
      reason: "invalid-registration",
      message: "The Claude Code callback has no session identity or working folder.",
    };
  if (input.hook_event_name !== "SessionStart") {
    const current = withNativeRegistration(
      root,
      undefined,
      (registration) => registration,
      claudeSessionAuthority(input.session_id),
    );
    return current.ok ? { ok: true, registration: current.value } : current;
  }
  // Compaction continues the same lifecycle.
  if (input.source === "compact") return { ok: true, skipped: true };
  if (
    typeof input.source !== "string" ||
    !["startup", "resume", "clear", "fork"].includes(input.source)
  )
    return {
      ok: false,
      reason: "invalid-registration",
      message:
        "This Claude Code SessionStart source is unsupported. Start or resume the session before connecting Lucid.",
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
      message: "The Claude Code native process could not be verified.",
    };
  const capture = {
    harness: "claude" as const,
    interface: "claude-cli" as const,
    nativeSessionId: input.session_id,
    owner,
    workingDirectory: input.cwd,
  };
  return registerNativeSession(
    root,
    capture,
    nativeRegistrationAuthority(
      (candidate) =>
        candidate.harness === capture.harness &&
        candidate.interface === capture.interface &&
        candidate.nativeSessionId === capture.nativeSessionId &&
        candidate.workingDirectory === capture.workingDirectory &&
        sameProcessOwner(candidate.owner, capture.owner),
    ),
  );
}

export type ClaudeHookResult =
  | NativeListenerResult
  | { readonly kind: "skipped" }
  | { readonly context: string; readonly kind: "committed" }
  | { readonly kind: "notice"; readonly message: string };

interface ClaudeHookOptions extends NativeStopOptions {
  readonly native?: ClaudeHookDeps;
  readonly retryMs?: number;
}

function commitOperation(
  records: Conversations,
  operation: ClaudeOperation,
  registration: NativeBinding,
  authority: RegistrationAuthority,
): string {
  const { conversationId } = operation;
  switch (operation.kind) {
    case "bind": {
      const status = connectPublication(
        records,
        conversationId,
        registration.registrationId,
        authority,
      );
      return `Connection for ${conversationId}: ${status.state}. ${status.message}`;
    }
    case "listen":
      return `Listening for ${conversationId}: ${requestNativeListening(records, conversationId, authority).message}`;
    case "receipt":
    case "respond": {
      const control: ConnectionControl =
        operation.kind === "receipt"
          ? { kind: "receipt", offerId: operation.offerId }
          : { kind: "respond", offerId: operation.offerId, outcome: operation.outcome };
      const result = runConnectionControl(records, conversationId, control, authority);
      return `${operation.kind === "receipt" ? "Receipt" : "Response"} for offer ${operation.offerId}: ${result.verdict}. ${result.message}`;
    }
  }
}

/** Commit proposals reported by a parent Bash call. A subagent's proposal is claimed and refused. */
function commitProposals(
  records: Conversations,
  input: Payload,
  nonces: readonly string[],
): string {
  const lines: string[] = [];
  const subagent = input.agent_id !== undefined;
  let registration: NativeBinding | undefined;
  let authority: RegistrationAuthority | undefined;
  let failure: string | undefined;
  if (!subagent && typeof input.session_id === "string") {
    authority = claudeSessionAuthority(input.session_id);
    const current = withNativeRegistration(
      records.rootDir,
      undefined,
      (binding) => binding,
      authority,
    );
    if (current.ok) registration = current.value;
    else failure = `${current.reason}: ${current.message}`;
  }
  for (const nonce of nonces) {
    const proposal = claimClaudeProposal(records.rootDir, nonce);
    if (!proposal) {
      lines.push(`${nonce}: not recorded. The request expired, was already used, or is invalid.`);
      continue;
    }
    if (subagent) {
      const message = "It ran in a subagent; run the command from the main conversation.";
      // A refused connection is saved beside the publication so the browser explains it.
      if (proposal.operation.kind === "bind")
        refusePublicationConnection(
          records,
          proposal.operation.conversationId,
          "subagent-provenance",
          `Artifact published; connection refused. ${message}`,
        );
      lines.push(`${nonce}: not recorded. ${message}`);
      continue;
    }
    if (!registration || !authority) {
      lines.push(`${nonce}: not recorded. ${failure ?? "The Claude Code session is unverified."}`);
      continue;
    }
    if (proposal.registrationId !== registration.registrationId) {
      lines.push(
        `${nonce}: not recorded. It was saved by a different native lifecycle; run the command again.`,
      );
      continue;
    }
    try {
      lines.push(commitOperation(records, proposal.operation, registration, authority));
    } catch (cause) {
      lines.push(
        `${nonce}: not recorded. ${cause instanceof Error ? cause.message : "The operation failed."}`,
      );
    }
  }
  return `Lucid results:\n${lines.join("\n")}`;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runClaudeHook(
  records: Conversations,
  payload: unknown,
  options: ClaudeHookOptions,
): Promise<ClaudeHookResult> {
  const deps = options.native ?? defaultDeps();
  const input = (payload && typeof payload === "object" ? payload : {}) as Payload;
  if (input.hook_event_name === "PostToolUse") {
    // Every parent Bash call reaches this hook; only reported proposals touch storage.
    const response = input.tool_response as Payload | undefined;
    const stdout = typeof response?.stdout === "string" ? response.stdout : "";
    if (
      deps.role !== undefined ||
      input.tool_name !== "Bash" ||
      !stdout.includes(CLAUDE_PROPOSAL_MARKER)
    )
      return { kind: "skipped" };
    const nonces = proposalNonces(stdout);
    return nonces.length === 0
      ? { kind: "skipped" }
      : { context: commitProposals(records, input, nonces), kind: "committed" };
  }
  const captured = await captureClaudeAuthor(records.rootDir, payload, deps);
  if (!captured.ok) {
    // Lucid is not configured for this session: ordinary turns stay silent.
    if (captured.reason === "registration-missing") return { kind: "skipped" };
    return { kind: "held", message: captured.message, reason: captured.reason };
  }
  if ("skipped" in captured || input.hook_event_name === "SessionStart") return { kind: "skipped" };
  const { registration } = captured;
  const authority = claudeSessionAuthority(registration.nativeSessionId);
  if (input.hook_event_name === "UserPromptSubmit") {
    // Claude Code has no Interrupt callback. Any new prompt, including a background task
    // notification, ends listening. A Stop wait releases the registry lock between polls.
    const deadline = Date.now() + 2_000;
    for (;;) {
      const result = interruptNativeListening(records, registration, authority);
      if (result.kind !== "held" || result.reason !== "registration-busy" || Date.now() > deadline)
        return result;
      await pause(options.retryMs ?? 50);
    }
  }
  // Claude Code counts consecutive Stop continuations and resets when a Stop is not one.
  const stored = readStopBlocks(records.rootDir, registration.registrationId);
  const active = input.stop_hook_active === true;
  const blocks = active ? stored : 0;
  if (!active && stored !== 0) writeStopBlocks(records.rootDir, registration.registrationId, 0);
  if (deps.blockCap > 0 && blocks >= deps.blockCap) {
    if (!hasNativeListenRequest(records, registration, authority)) return { kind: "skipped" };
    const stopped = interruptNativeListening(records, registration, authority);
    return stopped.kind === "held"
      ? stopped
      : {
          kind: "notice",
          message:
            "Lucid stopped listening: Claude Code's consecutive Stop hook limit was reached. Saved feedback stays in the conversation; run lucid connection resume-listen to continue.",
        };
  }
  const result = await listenAtNativeStop(records, registration, authority, options);
  if (result.kind === "offered")
    writeStopBlocks(records.rootDir, registration.registrationId, blocks + 1);
  const [first] = result.kind === "stopped" ? (result.held ?? []) : [];
  if (result.kind === "stopped" && result.reason === "expired" && first) {
    const count = result.held?.length ?? 1;
    return {
      kind: "notice",
      message: `Lucid could not send ${count === 1 ? "1 saved feedback item" : `${count} saved feedback items`}: ${first.message} Listening has ended; run lucid connection resume-listen after resolving it.`,
    };
  }
  return result;
}
