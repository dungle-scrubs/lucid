import { closeSync, constants, openSync, readSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { readParentPid, readProcessOwner } from "../../process-owner.js";
import { path } from "../../protocol/connection.js";
import { isWireId } from "../../protocol/frames.js";
import type { ProcessOwner } from "../../protocol/process-owner.js";
import { sameProcessOwner } from "../../protocol/process-owner.js";
import {
  claimNativeProposal,
  PROPOSAL_MARKERS,
  proposalNonces,
} from "../../store/native-proposals.js";
import {
  nativeRegistrationAuthority,
  registerNativeSession,
  removeNativeRegistration,
  withNativeRegistration,
} from "../../store/native-registration.js";
import { refusePublicationConnection } from "../artifact-publish.js";
import { piSessionAuthority } from "../pi-commands.js";
import type { Conversations } from "../record-addressing.js";
import { commitOperation } from "./native-commit.js";

/** The Pi extension's helper events (RFC 28 slice 3). `settled` arrives with listening. */
export type PiHookEvent = "session-start" | "session-shutdown" | "tool-result";

/** One helper capture from stdin is bounded before it is parsed. */
export const PI_CAPTURE_MAX_BYTES = 65_536;

/** A capture past the bound is refused before parsing (RFC 28 Message Formats). */
export const PI_CAPTURE_OVERSIZE_MESSAGE = "The Pi hook capture is too large.";

const INVALID_CAPTURE_MESSAGE = "The Pi hook capture is invalid.";
const UNVERIFIED_PARENT_MESSAGE = "The Pi process that started this helper could not be verified.";
const RUNTIME_ANCESTRY_MESSAGE =
  "This Pi session runs inside another JavaScript runtime or Pi process, so Lucid does not register it. Start Pi directly from a terminal.";
const ORPHAN_OWNER_MESSAGE =
  "This Pi process has no parent shell, so Lucid does not register it. Start Pi directly from a terminal.";
const SESSION_FILE_MESSAGE =
  "This Pi session's own session file does not match the captured session or folder, so Lucid does not register it.";

const BASE_KEYS = [
  "v",
  "event",
  "mode",
  "pid",
  "execPath",
  "nativeSessionId",
  "sessionFile",
  "workingDirectory",
] as const;
const TOOL_RESULT_KEYS = [...BASE_KEYS, "toolCallId", "markers"] as const;
const MARKER = PROPOSAL_MARKERS["pi-cli"];

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface PiHookDeps {
  /** The process that spawned this helper; it must be the captured Pi process. */
  readonly parentPid: () => number;
  readonly probe: (pid: number) => ReturnType<typeof readProcessOwner>;
  /** The first line of a file, or null when it cannot be read; bounds the session-file check. */
  /** The file's first line; `undefined` when the file does not exist, `null` when unreadable. */
  readonly readFirstLine: (path: string) => string | null | undefined;
  readonly readParentPid: (pid: number) => number | null | undefined;
  readonly realpath: (path: string) => string;
  readonly now: () => number;
}

export type PiHookResult =
  | {
      readonly v: 1;
      readonly kind: "registered";
      readonly registrationId: string;
      readonly generation: string;
    }
  | { readonly v: 1; readonly kind: "removed"; readonly removed: boolean }
  | { readonly v: 1; readonly kind: "committed"; readonly text: string }
  | { readonly v: 1; readonly kind: "refused"; readonly reason: string; readonly message: string };

const refused = (reason: string, message: string): PiHookResult => ({
  kind: "refused",
  message,
  reason,
  v: 1,
});

/** The first line of a session file, at most 64 KiB in; null when it cannot be read. */
function readHeaderLine(path: string): string | null | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(65_536);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytes).toString("utf8");
      const newline = text.indexOf("\n");
      return newline === -1 ? text : text.slice(0, newline);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/** Read at most `maxBytes`; a larger input stops reading and reports `null` without parsing. */
export async function readBoundedInput(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<string | null> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    parts.push(bytes);
    total += bytes.length;
    if (total > maxBytes) return null;
  }
  return Buffer.concat(parts).toString("utf8");
}

interface PiCapture {
  readonly execPath: string;
  readonly markers?: readonly unknown[];
  readonly mode: string;
  readonly nativeSessionId: string;
  readonly pid: number;
  readonly sessionFile: string | null;
  readonly toolCallId?: unknown;
  readonly workingDirectory: string;
}

/** Every listed key is required for its event and no other key is accepted. */
function parseCapture(event: PiHookEvent, text: string): PiCapture | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!object(raw)) return null;
  const required = event === "tool-result" ? TOOL_RESULT_KEYS : BASE_KEYS;
  const names = new Set<string>(Object.keys(raw));
  if (names.size !== required.length || required.some((key) => !names.has(key))) return null;
  if (raw.v !== 1 || raw.event !== event || raw.mode !== "tui") return null;
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 1) return null;
  if (!path(raw.execPath) || !path(raw.workingDirectory)) return null;
  if (raw.sessionFile !== null && !path(raw.sessionFile)) return null;
  if (typeof raw.nativeSessionId !== "string" || !isWireId(raw.nativeSessionId)) return null;
  if (event === "tool-result") {
    const toolCallId = raw.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length < 1 || toolCallId.length > 256)
      return null;
    if (!Array.isArray(raw.markers) || raw.markers.length < 1 || raw.markers.length > 16)
      return null;
    for (const marker of raw.markers)
      if (typeof marker !== "string" || marker.length > 512 || !marker.startsWith(MARKER))
        return null;
  }
  return {
    execPath: raw.execPath,
    ...(event === "tool-result"
      ? { markers: raw.markers as readonly unknown[], toolCallId: raw.toolCallId }
      : {}),
    mode: raw.mode,
    nativeSessionId: raw.nativeSessionId,
    pid: raw.pid as number,
    sessionFile: raw.sessionFile,
    workingDirectory: raw.workingDirectory,
  };
}

/** RFC 28 "Roles by mode": the helper's direct parent must be the captured Pi process,
 * and that process must be the JavaScript runtime the capture names. */
function verifyParent(
  capture: PiCapture,
  deps: PiHookDeps,
):
  | { readonly owner: ProcessOwner; readonly ownerParentPid: number }
  | { readonly message: string } {
  if (deps.parentPid() !== capture.pid) return { message: UNVERIFIED_PARENT_MESSAGE };
  const snapshot = deps.probe(capture.pid);
  if (!snapshot) return { message: UNVERIFIED_PARENT_MESSAGE };
  let runtime: string;
  let captured: string;
  try {
    runtime = deps.realpath(snapshot.executable);
    captured = deps.realpath(capture.execPath);
  } catch {
    return { message: UNVERIFIED_PARENT_MESSAGE };
  }
  const base = basename(runtime);
  if ((base !== "node" && base !== "bun") || runtime !== captured)
    return { message: UNVERIFIED_PARENT_MESSAGE };
  return {
    owner: { executable: snapshot.executable, pid: snapshot.pid, startedAt: snapshot.startedAt },
    ownerParentPid: snapshot.parentPid,
  };
}

/** RFC 28 registration rule: a real Pi TUI starts from a shell or terminal, so an
 * owner with a JavaScript runtime or a Pi process above it is a helper a model
 * started, not this session. Walking stops at pid 1 after at most 64 steps; an
 * unreadable ancestor is skipped by its parent pid and never itself a refusal. */
function ownerUnderRuntimeOrPi(startPid: number, deps: PiHookDeps): boolean {
  const visited = new Set<number>();
  let pid = startPid;
  while (pid > 1 && visited.size < 64 && !visited.has(pid)) {
    visited.add(pid);
    const snapshot = deps.probe(pid);
    if (!snapshot) {
      const parent = deps.readParentPid(pid);
      if (parent === undefined || parent === null) return false;
      pid = parent;
      continue;
    }
    let base: string;
    try {
      base = basename(deps.realpath(snapshot.executable));
    } catch {
      base = basename(snapshot.executable);
    }
    if (base === "node" || base === "bun" || base === "deno" || base === "pi") return true;
    pid = snapshot.parentPid;
  }
  return false;
}

/** The session file's header line must name the captured session and folder. A null
 * return accepts. Pi 0.87.1 reports a new session's file path at `session_start` before
 * it writes the file, so a missing file, like `sessionFile: null`, is accepted; the
 * owner-ancestry rule, not this check, refuses an owner a model started. */
function sessionFileRefusal(capture: PiCapture, deps: PiHookDeps): string | null {
  if (capture.sessionFile === null) return null;
  const line = deps.readFirstLine(capture.sessionFile);
  if (line === undefined) return null;
  let header: unknown;
  try {
    header = JSON.parse(line ?? "");
  } catch {
    return SESSION_FILE_MESSAGE;
  }
  if (!object(header)) return SESSION_FILE_MESSAGE;
  const record = header as Record<string, unknown>;
  if (record.type !== "session" || record.id !== capture.nativeSessionId)
    return SESSION_FILE_MESSAGE;
  if (typeof record.cwd !== "string") return SESSION_FILE_MESSAGE;
  try {
    return deps.realpath(record.cwd) === deps.realpath(capture.workingDirectory)
      ? null
      : SESSION_FILE_MESSAGE;
  } catch {
    return SESSION_FILE_MESSAGE;
  }
}

/** Map a registration lookup failure to the commit line's refusal reason (RFC 28 step 3). */
function commitRefusalReason(reason: string): string {
  return reason === "stale-registration" ? "registration-replaced" : reason;
}

export async function runPiHook(
  records: Conversations,
  event: PiHookEvent,
  text: string,
  deps: Partial<PiHookDeps> = {},
): Promise<PiHookResult> {
  const d: PiHookDeps = {
    now: Date.now,
    parentPid: () => process.ppid,
    probe: readProcessOwner,
    readFirstLine: readHeaderLine,
    readParentPid,
    realpath: (value) => realpathSync.native(value),
    ...deps,
  };
  const capture = parseCapture(event, text);
  if (!capture) return refused("invalid-capture", INVALID_CAPTURE_MESSAGE);
  const parent = verifyParent(capture, d);
  if (!("owner" in parent)) return refused("native-context-unverified", parent.message);
  const { owner, ownerParentPid } = parent;
  if (event === "session-start") {
    // A real Pi TUI always has its shell as its parent; an owner parented to
    // pid 1 or 0 is a detached process, not a session a person started.
    if (ownerParentPid <= 1) return refused("native-context-unverified", ORPHAN_OWNER_MESSAGE);
    if (ownerUnderRuntimeOrPi(ownerParentPid, d))
      return refused("native-context-unverified", RUNTIME_ANCESTRY_MESSAGE);
    const sessionFile = sessionFileRefusal(capture, d);
    if (sessionFile !== null) return refused("native-context-unverified", sessionFile);
    // Registration corroborates the whole capture, as the Claude SessionStart hook does.
    const result = registerNativeSession(
      records.rootDir,
      {
        harness: "pi",
        interface: "pi-cli",
        nativeSessionId: capture.nativeSessionId,
        owner,
        workingDirectory: capture.workingDirectory,
      },
      nativeRegistrationAuthority(
        (candidate) =>
          candidate.harness === "pi" &&
          candidate.interface === "pi-cli" &&
          candidate.nativeSessionId === capture.nativeSessionId &&
          candidate.workingDirectory === capture.workingDirectory &&
          sameProcessOwner(candidate.owner, owner),
        d.probe,
      ),
    );
    return result.ok
      ? {
          generation: result.registration.generation,
          kind: "registered",
          registrationId: result.registration.registrationId,
          v: 1,
        }
      : refused(result.reason, result.message);
  }
  if (event === "session-shutdown") {
    const result = removeNativeRegistration(
      records.rootDir,
      "pi-cli",
      owner,
      capture.nativeSessionId,
    );
    return "removed" in result
      ? { kind: "removed", removed: result.removed, v: 1 }
      : refused(result.reason, result.message);
  }
  // Commits locate the registration through the callback's session; the session itself
  // proves nothing beyond locating (RFC 28 Security Considerations).
  const authority = piSessionAuthority(capture.nativeSessionId, d.probe);
  const lines: string[] = [];
  for (const nonce of proposalNonces("pi-cli", (capture.markers ?? []).join("\n"))) {
    const proposal = claimNativeProposal(records.rootDir, "pi-cli", nonce, d.now());
    if (!proposal) {
      lines.push(`${nonce}: not found or expired`);
      continue;
    }
    const refuse = (reason: string): void => {
      lines.push(`${nonce}: refused (${reason})`);
      // A refused bind is claimed and saved beside the publication, as for Claude.
      if (proposal.operation.kind === "bind")
        refusePublicationConnection(
          records,
          proposal.operation.conversationId,
          reason,
          `Artifact published; connection refused: ${reason}.`,
        );
    };
    // The proposal names the session whose registration saved it; a capture from any
    // other session never reaches the registration lookup.
    if (proposal.nativeSessionId !== capture.nativeSessionId) {
      refuse("proposal-session-mismatch");
      continue;
    }
    // The registration is resolved under the registry lock; the commit runs after it,
    // as the Claude hook does, because every operation re-enters the same lock.
    const current = withNativeRegistration(
      records.rootDir,
      proposal.registrationId,
      (registration) => registration,
      authority,
    );
    if (!current.ok) {
      // A busy registry saves nothing: the command can simply run again.
      if (current.reason === "registration-busy") {
        lines.push(`${nonce}: not recorded, Lucid was busy; run the command again`);
        continue;
      }
      refuse(commitRefusalReason(current.reason));
      continue;
    }
    const registration = current.value;
    if (
      !sameProcessOwner(registration.owner, owner) ||
      registration.nativeSessionId !== capture.nativeSessionId
    ) {
      refuse("proposal-session-mismatch");
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
  return { kind: "committed", text: `Lucid results:\n${lines.join("\n")}`, v: 1 };
}
