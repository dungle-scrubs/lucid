import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { NativeBinding } from "../protocol/connection.js";
import { connectionId } from "../protocol/connection.js";
import { TEXT_MAX } from "../protocol/frames.js";
import { atomicSidecar } from "./atomic-file.js";
import { validConversationId } from "./errors.js";

/**
 * Claude Code runs a subagent's Bash commands with the parent's session ID and process.
 * A command therefore cannot prove its own provenance. It saves one of these proposals;
 * the parent session's PostToolUse callback, which carries a subagent marker, commits it.
 */
export type ClaudeOperation =
  | { readonly kind: "bind"; readonly conversationId: string }
  | { readonly kind: "listen"; readonly conversationId: string }
  | { readonly kind: "receipt"; readonly conversationId: string; readonly offerId: string }
  | {
      readonly kind: "respond";
      readonly conversationId: string;
      readonly offerId: string;
      readonly outcome: unknown;
    };

export interface ClaudeProposal {
  readonly createdAt: number;
  readonly nonce: string;
  readonly operation: ClaudeOperation;
  readonly registrationId: string;
}

/** A proposal that no foreground parent Bash call reports within this window is never committed. */
export const CLAUDE_PROPOSAL_TTL_MS = 10 * 60 * 1000;
export const CLAUDE_PROPOSAL_MARKER = "lucid-claude-proposal:";
const PROPOSAL_BYTES = TEXT_MAX * 4 + 4096;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function privateDir(root: string, name: string): string {
  const dir = join(root, ".registrations", "claude-cli", name);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  for (const path of [join(root, ".registrations", "claude-cli"), dir]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Claude proposal storage must be a private directory owned by this user");
  }
  return dir;
}

function parseOperation(value: unknown): ClaudeOperation | null {
  if (!object(value) || typeof value.conversationId !== "string") return null;
  if (!validConversationId(value.conversationId)) return null;
  const conversationId = value.conversationId;
  if (value.kind === "bind" || value.kind === "listen") return { kind: value.kind, conversationId };
  if (typeof value.offerId !== "string" || !connectionId(value.offerId)) return null;
  if (value.kind === "receipt") return { kind: "receipt", conversationId, offerId: value.offerId };
  if (value.kind === "respond")
    return { kind: "respond", conversationId, offerId: value.offerId, outcome: value.outcome };
  return null;
}

export function saveClaudeProposal(
  root: string,
  registration: NativeBinding,
  operation: ClaudeOperation,
  now = Date.now(),
): ClaudeProposal {
  const proposal: ClaudeProposal = {
    createdAt: now,
    nonce: crypto.randomUUID(),
    operation,
    registrationId: registration.registrationId,
  };
  atomicSidecar(join(privateDir(root, "proposals"), `${proposal.nonce}.json`), proposal);
  return proposal;
}

/** Proposal nonces named in text, in order, without duplicates. */
export function proposalNonces(text: string): readonly string[] {
  const pattern = new RegExp(`${CLAUDE_PROPOSAL_MARKER}([0-9a-f-]{36})`, "gi");
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] ?? ""))].filter(
    connectionId,
  );
}

/** Claiming renames the proposal first, so one callback at most can commit it. */
export function claimClaudeProposal(
  root: string,
  nonce: string,
  now = Date.now(),
): ClaudeProposal | null {
  if (!connectionId(nonce)) return null;
  const dir = privateDir(root, "proposals");
  const claimed = join(dir, `${nonce}.${crypto.randomUUID()}.claimed`);
  try {
    renameSync(join(dir, `${nonce}.json`), claimed);
  } catch {
    return null;
  }
  try {
    const fd = openSync(claimed, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: unknown;
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > PROPOSAL_BYTES ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.()
      )
        return null;
      raw = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (!object(raw) || raw.nonce !== nonce || !connectionId(raw.registrationId)) return null;
    const operation = parseOperation(raw.operation);
    const createdAt = raw.createdAt;
    if (
      !operation ||
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt) ||
      createdAt > now ||
      now - createdAt > CLAUDE_PROPOSAL_TTL_MS
    )
      return null;
    return { createdAt, nonce, operation, registrationId: raw.registrationId };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(claimed);
    } catch {}
  }
}

/** Consecutive Stop continuations Lucid produced for one registration. Unreadable state
 * counts as unlimited, so an unknown count never produces a continuation past the cap. */
export function readStopBlocks(root: string, registrationId: string): number {
  let fd: number;
  try {
    fd = openSync(
      join(privateDir(root, "stops"), `${registrationId}.json`),
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
  atomicSidecar(join(privateDir(root, "stops"), `${registrationId}.json`), { count });
}
