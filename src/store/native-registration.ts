import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ownerPresence, readProcessOwner } from "../process-owner.js";
import type { NativeBinding } from "../protocol/connection.js";
import { connectionId, parseNativeBinding } from "../protocol/connection.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import { atomicSidecar } from "./atomic-file.js";
import { classifyStoreFailure } from "./errors.js";
import { type AppendLock, acquireAppendLock, LockError } from "./flock.js";

export interface RegistrationAuthority {
  readonly callerOwns: (owner: ProcessOwner) => boolean | undefined;
  readonly ownerPresence: (owner: ProcessOwner) => boolean | undefined;
}

/** A lifecycle adapter supplies this after it has verified parent-session provenance. */
export type NativeCapture = Omit<NativeBinding, "generation" | "registrationId">;
export interface RegistrationFailure {
  readonly message: string;
  readonly ok: false;
  readonly reason: string;
}
type RegistrationResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | RegistrationFailure;

function callerOwns(owner: ProcessOwner, probe = readProcessOwner): boolean | undefined {
  let pid = process.pid;
  const visited = new Set<number>();
  while (pid > 1 && visited.size < 64 && !visited.has(pid)) {
    visited.add(pid);
    const current = probe(pid);
    if (current === undefined) return undefined;
    if (current === null) return false;
    if (current.pid === owner.pid)
      return current.executable === owner.executable && current.startedAt === owner.startedAt;
    pid = current.parentPid;
  }
  return pid <= 1 ? false : undefined;
}
/** Cache caller ancestry within one command; final native owner checks stay fresh. */
export function nativeRegistrationAuthority(): RegistrationAuthority {
  const snapshots = new Map<number, ReturnType<typeof readProcessOwner>>();
  const probe = (pid: number): ReturnType<typeof readProcessOwner> => {
    if (!snapshots.has(pid)) snapshots.set(pid, readProcessOwner(pid));
    return snapshots.get(pid);
  };
  return { callerOwns: (owner) => callerOwns(owner, probe), ownerPresence };
}

const failure = (reason: string, message: string): RegistrationFailure => ({
  message,
  ok: false,
  reason,
});

/** The registration lock precedes any record append lock acquired by the callback. */
function withRegistrations<TValue>(
  root: string,
  operation: (dir: string) => TValue,
): RegistrationResult<TValue> {
  const dir = join(root, ".registrations");
  let lock: AppendLock;
  try {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const stat = lstatSync(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700 ||
      stat.uid !== process.getuid?.()
    )
      return failure(
        "registration-store-unavailable",
        "Native registration storage must be a private directory owned by this user.",
      );
    lock = acquireAppendLock(join(dir, "registry"), { privateFile: true, timeoutMs: 0 });
  } catch (cause) {
    if (cause instanceof LockError && cause.code === "lock-timeout")
      return failure(
        "registration-busy",
        "Native registration is being updated. Retry connection after the update finishes.",
      );
    return failure(
      "registration-store-unavailable",
      "Native registration could not be verified. Check access to its storage and retry connection.",
    );
  }
  try {
    return { ok: true, value: operation(dir) };
  } finally {
    lock.release();
  }
}

function readRegistration(path: string): NativeBinding {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Invalid native registration file");
    const value = parseNativeBinding(JSON.parse(readFileSync(fd, "utf8")));
    if (!value) throw new Error("Invalid native registration");
    return value;
  } finally {
    closeSync(fd);
  }
}

export function registerNativeSession(
  root: string,
  capture: NativeCapture,
  authority: RegistrationAuthority = nativeRegistrationAuthority(),
): { readonly ok: true; readonly registration: NativeBinding } | RegistrationFailure {
  const registration = parseNativeBinding({
    ...capture,
    generation: crypto.randomUUID(),
    registrationId: crypto.randomUUID(),
  });
  if (!registration)
    return failure(
      "invalid-registration",
      "The native lifecycle callback has an unsupported identity or working folder.",
    );
  if (
    authority.callerOwns(registration.owner) !== true ||
    authority.ownerPresence(registration.owner) !== true
  )
    return failure("owner-unknown", "The native owner could not be corroborated.");
  const result = withRegistrations(root, (dir): RegistrationResult<NativeBinding> => {
    const key = createHash("sha256")
      .update(JSON.stringify([registration.interface, registration.owner]))
      .digest("hex");
    try {
      atomicSidecar(join(dir, `${key}.json`), registration);
      return { ok: true, value: registration };
    } catch {
      return failure(
        "registration-store-unavailable",
        "The native registration could not be saved. Check access to its storage.",
      );
    }
  });
  if (!result.ok) return result;
  return result.value.ok ? { ok: true, registration: result.value.value } : result.value;
}

export function withNativeRegistration<TValue>(
  root: string,
  reference: unknown,
  operation: (registration: NativeBinding) => TValue,
  authority: RegistrationAuthority = nativeRegistrationAuthority(),
): RegistrationResult<TValue> {
  if (reference !== undefined && !connectionId(reference))
    return failure("invalid-registration", "The registration reference is invalid.");
  const result = withRegistrations(root, (dir): RegistrationResult<TValue> => {
    let registrations: NativeBinding[];
    try {
      registrations = readdirSync(dir)
        .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
        .flatMap((name) => {
          const path = join(dir, name);
          const registration = readRegistration(path);
          let alive: boolean | undefined;
          try {
            alive = authority.ownerPresence(registration.owner);
          } catch {
            /* Unavailable inspection never authorizes cleanup. */
          }
          if (alive !== false) return [registration];
          unlinkSync(path);
          return [];
        });
    } catch {
      return failure(
        "registration-store-unavailable",
        "A native registration is unreadable or invalid. Connection cannot be verified until its storage is repaired.",
      );
    }
    const matches: NativeBinding[] = [];
    let unknown = false;
    for (const registration of registrations) {
      const owns = authority.callerOwns(registration.owner);
      if (owns === undefined) unknown = true;
      if (owns === true) matches.push(registration);
    }
    if (unknown)
      // An unverified registration cannot be proved unrelated to the caller.
      return failure("owner-unknown", "The calling native session could not be verified.");
    if (matches.length > 1)
      return failure(
        "native-identity-conflict",
        "More than one native registration matches this process. Resolve the conflicting registrations before connecting.",
      );
    const registration = matches[0];
    if (!registration)
      return failure(
        "registration-missing",
        "Artifact published; connection needs setup. Interactive mode needs a connected session.",
      );
    if (reference !== undefined && registration.registrationId !== reference)
      return failure(
        "stale-registration",
        "The native registration changed. Reconnect from the intended session.",
      );
    if (authority.ownerPresence(registration.owner) !== true)
      return failure("owner-unknown", "The native owner could not be corroborated.");
    try {
      return { ok: true, value: operation(registration) };
    } catch (cause) {
      const reason = classifyStoreFailure(cause) ?? "record-write-failed";
      const message =
        reason === "record-busy"
          ? "The artifact is published, but its conversation is busy. Retry connection after the current write finishes."
          : reason === "record-unreadable"
            ? "The artifact is published, but its conversation history could not be read. Connection remains unverified."
            : "The artifact is published, but its connection could not be saved. Check access to the conversation and retry connection.";
      return failure(reason, message);
    }
  });
  return result.ok ? result.value : result;
}
