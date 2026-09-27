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
import { isWireId, TEXT_MAX } from "../protocol/frames.js";
import { atomicSidecar } from "./atomic-file.js";
import { validConversationId } from "./errors.js";

/**
 * A native tool command cannot prove its own provenance, so it saves one of
 * these proposals; the parent session's lifecycle callback commits it. The
 * store is shared by every proposal interface (RFC 28); each interface keeps
 * its own proposals folder and marker line.
 */
export type ProposalInterface = "claude-cli" | "pi-cli";

export type NativeOperation =
  | { readonly kind: "bind"; readonly conversationId: string }
  | { readonly kind: "listen"; readonly conversationId: string }
  | { readonly kind: "receipt"; readonly conversationId: string; readonly offerId: string }
  | {
      readonly kind: "respond";
      readonly conversationId: string;
      readonly offerId: string;
      readonly outcome: unknown;
    };

export interface NativeProposal {
  readonly createdAt: number;
  /** The native session whose registration saved this; the committing callback must name it. */
  readonly nativeSessionId?: string;
  readonly nonce: string;
  readonly operation: NativeOperation;
  readonly registrationId: string;
}

/** A proposal that no foreground parent tool call reports within this window is never committed. */
export const NATIVE_PROPOSAL_TTL_MS = 10 * 60 * 1000;

export const PROPOSAL_MARKERS: Readonly<Record<ProposalInterface, string>> = {
  "claude-cli": "lucid-claude-proposal:",
  "pi-cli": "lucid-pi-proposal:",
};
const PROPOSAL_BYTES = TEXT_MAX * 4 + 4096;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function proposalPrivateDir(root: string, iface: ProposalInterface, name: string): string {
  const dir = join(root, ".registrations", iface, name);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  for (const path of [join(root, ".registrations", iface), dir]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(`${iface} proposal storage must be a private directory owned by this user`);
  }
  return dir;
}

function parseOperation(value: unknown): NativeOperation | null {
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

export function saveNativeProposal(
  root: string,
  registration: NativeBinding,
  operation: NativeOperation,
  now = Date.now(),
): NativeProposal {
  const iface = registration.interface;
  if (iface !== "claude-cli" && iface !== "pi-cli")
    throw new Error(`Unsupported proposal interface: ${iface}`);
  const proposal: NativeProposal = {
    createdAt: now,
    nativeSessionId: registration.nativeSessionId,
    nonce: crypto.randomUUID(),
    operation,
    registrationId: registration.registrationId,
  };
  atomicSidecar(
    join(proposalPrivateDir(root, iface, "proposals"), `${proposal.nonce}.json`),
    proposal,
  );
  return proposal;
}

/** Proposal nonces named in text for one interface, in order, without duplicates. */
export function proposalNonces(iface: ProposalInterface, text: string): readonly string[] {
  const pattern = new RegExp(`${PROPOSAL_MARKERS[iface]}([0-9a-f-]{36})`, "gi");
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] ?? ""))].filter(
    connectionId,
  );
}

/** Claiming renames the proposal first, so one callback at most can commit it. */
export function claimNativeProposal(
  root: string,
  iface: ProposalInterface,
  nonce: string,
  now = Date.now(),
): NativeProposal | null {
  if (!connectionId(nonce)) return null;
  const dir = proposalPrivateDir(root, iface, "proposals");
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
    // The session is optional so proposals written before it existed still claim;
    // a present value that is not a wire id marks the file invalid.
    const nativeSessionId = raw.nativeSessionId;
    if (nativeSessionId !== undefined) {
      if (typeof nativeSessionId !== "string" || !isWireId(nativeSessionId)) return null;
    }
    const operation = parseOperation(raw.operation);
    const createdAt = raw.createdAt;
    if (
      !operation ||
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt) ||
      createdAt > now ||
      now - createdAt > NATIVE_PROPOSAL_TTL_MS
    )
      return null;
    return {
      createdAt,
      nonce,
      operation,
      registrationId: raw.registrationId,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(claimed);
    } catch {}
  }
}
