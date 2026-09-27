import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeBinding } from "../protocol/connection.js";
import { atomicSidecar } from "./atomic-file.js";
import {
  claimNativeProposal as claimInterfaceProposal,
  proposalNonces as interfaceProposalNonces,
  NATIVE_PROPOSAL_TTL_MS,
  type NativeOperation,
  type NativeProposal,
  PROPOSAL_MARKERS,
  type ProposalInterface,
  proposalPrivateDir,
  saveNativeProposal,
} from "./native-proposals.js";

/**
 * Claude Code runs a subagent's Bash commands with the parent's session ID and process.
 * A command therefore cannot prove its own provenance. It saves one of these proposals;
 * the parent session's PostToolUse callback, which carries a subagent marker, commits it.
 * The storage itself is interface-generic and lives in `native-proposals.ts` (RFC 28).
 */
export type ClaudeOperation = NativeOperation;
export type ClaudeProposal = NativeProposal;
export const CLAUDE_PROPOSAL_TTL_MS = NATIVE_PROPOSAL_TTL_MS;
export const CLAUDE_PROPOSAL_MARKER = PROPOSAL_MARKERS["claude-cli"];

const IFACE: ProposalInterface = "claude-cli";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function saveClaudeProposal(
  root: string,
  registration: NativeBinding,
  operation: ClaudeOperation,
  now = Date.now(),
): ClaudeProposal {
  return saveNativeProposal(root, registration, operation, now);
}

/** Proposal nonces named in text, in order, without duplicates. */
export function proposalNonces(text: string): readonly string[] {
  return interfaceProposalNonces(IFACE, text);
}

/** Claiming renames the proposal first, so one callback at most can commit it. */
export function claimClaudeProposal(
  root: string,
  nonce: string,
  now = Date.now(),
): ClaudeProposal | null {
  return claimInterfaceProposal(root, IFACE, nonce, now);
}

/** Consecutive Stop continuations Lucid produced for one registration. Unreadable state
 * counts as unlimited, so an unknown count never produces a continuation past the cap. */
export function readStopBlocks(root: string, registrationId: string): number {
  let fd: number;
  try {
    fd = openSync(
      join(proposalPrivateDir(root, IFACE, "stops"), `${registrationId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? 0 : Number.POSITIVE_INFINITY;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 || stat.uid !== process.getuid?.())
      return Number.POSITIVE_INFINITY;
    const raw = JSON.parse(readFileSync(fd, "utf8"));
    return object(raw) && Number.isSafeInteger(raw.count) && (raw.count as number) >= 0
      ? (raw.count as number)
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  } finally {
    closeSync(fd);
  }
}

export function writeStopBlocks(root: string, registrationId: string, count: number): void {
  atomicSidecar(join(proposalPrivateDir(root, IFACE, "stops"), `${registrationId}.json`), {
    count,
  });
}
