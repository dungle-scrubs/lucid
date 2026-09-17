import { isWireId } from "../protocol/frames.js";
import type { ClaudeOperation } from "../store/claude-proposals.js";
import { CLAUDE_PROPOSAL_MARKER, saveClaudeProposal } from "../store/claude-proposals.js";
import type { RegistrationAuthority } from "../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  withNativeRegistration,
} from "../store/native-registration.js";
import type { PublicationConnection, PublicationConnector } from "./artifact-publish.js";
import { refusePublicationConnection } from "./artifact-publish.js";
import { NATIVE_ROLE_ENV } from "./invocation.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

export type ClaudeProposalResult =
  | {
      readonly conversationId: string;
      readonly message: string;
      readonly proposal: string;
      readonly reason: null;
      readonly verdict: "pending";
    }
  | {
      readonly conversationId: string;
      readonly message: string;
      readonly reason: string;
      readonly verdict: "refused";
    };

const PENDING_MESSAGE =
  "Saved for the Claude Code session. Lucid records it when this foreground Bash call finishes and reports the result after the tool output. A subagent or background command cannot record it.";

/** The session a Claude Code tool command reports. It locates a registration but proves nothing. */
export function claudeCommandSession(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (env[NATIVE_ROLE_ENV] !== undefined) return undefined;
  const id = env.CLAUDE_CODE_SESSION_ID;
  return id !== undefined && isWireId(id) ? id : undefined;
}

/** Callback authority for a Claude session: caller ancestry reaches the registered owner and
 * the callback names the registered session. Hooks alone may use it; tool commands may not. */
export function claudeSessionAuthority(nativeSessionId: string): RegistrationAuthority {
  return nativeRegistrationAuthority(
    (candidate) =>
      candidate.harness === "claude" &&
      candidate.interface === "claude-cli" &&
      candidate.nativeSessionId === nativeSessionId,
  );
}

/** Save an operation for the parent PostToolUse callback. Nothing durable changes in the record. */
export function proposeClaudeOperation(
  records: Conversations,
  nativeSessionId: string,
  operation: ClaudeOperation,
): ClaudeProposalResult {
  const { conversationId } = operation;
  // Resolve the exact record before saving intent; a missing record is reported now.
  commandRecordDir(records, conversationId);
  const saved = withNativeRegistration(
    records.rootDir,
    undefined,
    (registration) => saveClaudeProposal(records.rootDir, registration, operation),
    claudeSessionAuthority(nativeSessionId),
  );
  if (!saved.ok)
    return { conversationId, message: saved.message, reason: saved.reason, verdict: "refused" };
  return {
    conversationId,
    message: PENDING_MESSAGE,
    proposal: `${CLAUDE_PROPOSAL_MARKER}${saved.value.nonce}`,
    reason: null,
    verdict: "pending",
  };
}

/** Publication writes the document now; its connection waits for the parent callback. */
export function claudePublicationConnector(nativeSessionId: string): PublicationConnector {
  return (records, conversationId): PublicationConnection => {
    const proposed = proposeClaudeOperation(records, nativeSessionId, {
      conversationId,
      kind: "bind",
    });
    if (proposed.verdict === "refused")
      return refusePublicationConnection(
        records,
        conversationId,
        proposed.reason,
        `Artifact published; connection refused: ${proposed.message}`,
      );
    return {
      message: `Artifact published. ${proposed.message}`,
      persistence: "saved",
      proposal: proposed.proposal,
      reason: "connection-pending",
      state: "setup-required",
    };
  };
}
