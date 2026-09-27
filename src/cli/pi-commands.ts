import { basename } from "node:path";
import { readProcessOwner } from "../process-owner.js";
import { isWireId } from "../protocol/frames.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import type { NativeOperation } from "../store/native-proposals.js";
import { PROPOSAL_MARKERS, saveNativeProposal } from "../store/native-proposals.js";
import type { RegistrationAuthority } from "../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  withNativeRegistration,
} from "../store/native-registration.js";
import type { PublicationConnection, PublicationConnector } from "./artifact-publish.js";
import { refusePublicationConnection } from "./artifact-publish.js";
import type { ClaudeProposalResult } from "./claude-commands.js";
import { NATIVE_ROLE_ENV } from "./invocation.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

const PENDING_MESSAGE =
  "Saved for the Pi session. Lucid records it when this Bash call finishes and reports the result after the tool output. A nested Pi or a background command cannot record it.";

const ANCESTRY_REFUSAL_MESSAGE =
  "Lucid did not save this: a JavaScript runtime or another Pi process runs between this command and the Pi session. Run the lucid binary directly from Pi's Bash tool, not through npx, bunx, pnpm, node, or a nested pi.";

/** The session a Pi tool command reports. It locates a registration but proves nothing. */
export function piCommandSession(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (env[NATIVE_ROLE_ENV] !== undefined) return undefined;
  const id = env.PI_SESSION_ID;
  return id !== undefined && isWireId(id) ? id : undefined;
}

/** Callback authority for a Pi session: caller ancestry reaches the registered owner and
 * the callback names the registered session. Hooks alone may use it; tool commands may not.
 * A hook passes its own process probe so the parent check and this authority read one view. */
export function piSessionAuthority(
  nativeSessionId: string,
  probe: (pid: number) => ReturnType<typeof readProcessOwner> = readProcessOwner,
): RegistrationAuthority {
  return nativeRegistrationAuthority(
    (candidate) =>
      candidate.harness === "pi" &&
      candidate.interface === "pi-cli" &&
      candidate.nativeSessionId === nativeSessionId,
    probe,
  );
}

/** RFC 28 step 2: every process between this command and the registered Pi owner must be
 * an ordinary parent (a shell), not a JavaScript runtime, a `pi` executable, or another
 * copy of the owner's executable. `null` means the chain is clean. */
export function proposalAncestryRefusal(
  owner: ProcessOwner,
  probe: typeof readProcessOwner = readProcessOwner,
  start: number = process.pid,
): string | null {
  const REFUSAL = "proposal-ancestry-unverified";
  const visited = new Set<number>([start]);
  let steps = 0;
  const own = probe(start);
  if (!own) return REFUSAL;
  let pid = own.parentPid;
  for (;;) {
    if (pid === owner.pid) return null;
    steps += 1;
    if (pid <= 1 || visited.has(pid) || steps > 64) return REFUSAL;
    visited.add(pid);
    const snapshot = probe(pid);
    if (!snapshot) return REFUSAL;
    const base = basename(snapshot.executable);
    if (
      base === "node" ||
      base === "bun" ||
      base === "deno" ||
      base === "pi" ||
      snapshot.executable === owner.executable
    )
      return REFUSAL;
    pid = snapshot.parentPid;
  }
}

/** Save an operation for the Pi session's `tool_result` callback. Nothing durable changes
 * in the record, and only when the command's ancestry to the registered owner is clean. */
export function proposePiOperation(
  records: Conversations,
  nativeSessionId: string,
  operation: NativeOperation,
): ClaudeProposalResult {
  const { conversationId } = operation;
  // Resolve the exact record before saving intent; a missing record is reported now.
  commandRecordDir(records, conversationId);
  const saved = withNativeRegistration(
    records.rootDir,
    undefined,
    (registration) => {
      const refusal = proposalAncestryRefusal(registration.owner);
      if (refusal !== null) return { refused: true as const };
      return {
        proposal: saveNativeProposal(records.rootDir, registration, operation),
        refused: false as const,
      };
    },
    piSessionAuthority(nativeSessionId),
  );
  if (!saved.ok)
    return {
      conversationId,
      message: saved.message,
      reason: saved.reason,
      verdict: "refused",
    };
  if (saved.value.refused)
    return {
      conversationId,
      message: ANCESTRY_REFUSAL_MESSAGE,
      reason: "proposal-ancestry-unverified",
      verdict: "refused",
    };
  return {
    conversationId,
    message: PENDING_MESSAGE,
    proposal: `${PROPOSAL_MARKERS["pi-cli"]}${saved.value.proposal.nonce}`,
    reason: null,
    verdict: "pending",
  };
}

/** Publication writes the document now; its connection waits for the `tool_result` callback. */
export function piPublicationConnector(nativeSessionId: string): PublicationConnector {
  return (records, conversationId): PublicationConnection => {
    const proposed = proposePiOperation(records, nativeSessionId, {
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
