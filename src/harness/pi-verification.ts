import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventKind } from "../protocol/events.js";
import { materializePiExtension } from "./pi-extension.js";
import type { NativeTurnOptions } from "./runner.js";

/** One verified Pi resume attempt (RFC 28 steps 7-11). */
export interface PiVerification {
  readonly attempt: string;
  readonly nonce: string;
  readonly attestationPath: string;
  readonly extensionPath: string;
  readonly expectedSession: string;
  readonly expectedCwd: string;
}

export type PiResumeOutcome =
  | { readonly kind: "verified" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "uncertain"; readonly detail: string };

/** What the turn showed, gathered while its events streamed. */
export interface PiResumeObservation {
  readonly completed: boolean;
  readonly agentEvents: boolean;
  readonly nativeExit3: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  "session-id-mismatch",
  "folder-mismatch",
  "session-empty",
  "verification-failed",
]);

/** Kinds that do not show the model ran. Every other kind, including one
 * Lucid does not know, counts as an agent event. */
const CONTROL_KINDS: ReadonlySet<string> = new Set([
  EventKind.identity,
  EventKind.progress,
  EventKind.error,
  EventKind.failure,
  EventKind.done,
]);
export const isAgentEventKind = (kind: string): boolean => !CONTROL_KINDS.has(kind);

/** hcn's report of a Pi process that exited 3: the extension's refusal code. */
export const isNativeExit3 = (event: Readonly<Record<string, unknown>>): boolean =>
  event.kind === EventKind.failure && event.class === "native" && event.nativeExitCode === 3;

/** Prepare one attempt: write the extension under the record root and make the
 * record's attestation folder. Throws when either cannot be written. */
export function preparePiVerification(opts: {
  readonly root: string;
  readonly recordDir: string;
  readonly launchId: string;
  readonly sessionId: string;
  readonly workingDirectory: string;
}): PiVerification {
  if (!UUID.test(opts.launchId)) throw new Error("The launch attempt ID is not a UUID");
  const extensionPath = materializePiExtension(opts.root);
  const dir = join(opts.recordDir, ".pi-attestation");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    attempt: opts.launchId,
    nonce: randomBytes(32).toString("hex"),
    attestationPath: join(dir, `${opts.launchId}.json`),
    extensionPath,
    expectedSession: opts.sessionId,
    expectedCwd: opts.workingDirectory,
  };
}

export function piNativeTurn(
  verification: PiVerification,
  settingsFingerprint: string,
): NativeTurnOptions {
  return {
    settingsFingerprint,
    env: {
      LUCID_PI_ATTEMPT: `${verification.attempt}.${verification.nonce}`,
      LUCID_PI_EXPECTED_SESSION: verification.expectedSession,
      LUCID_PI_EXPECTED_CWD: verification.expectedCwd,
      LUCID_PI_ATTESTATION: verification.attestationPath,
    },
    extensions: [verification.extensionPath],
  };
}

type Attestation =
  | { readonly outcome: "verified" }
  | { readonly outcome: "refused"; readonly reason: string }
  | null;

function readAttestation(verification: PiVerification): Attestation {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(verification.attestationPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.attempt !== verification.attempt ||
    record.nonce !== verification.nonce ||
    record.expected !== verification.expectedSession
  )
    return null;
  if (record.outcome === "verified" && record.reason === undefined) return { outcome: "verified" };
  if (
    record.outcome === "refused" &&
    typeof record.reason === "string" &&
    REFUSAL_REASONS.has(record.reason)
  )
    return { outcome: "refused", reason: record.reason };
  return null;
}

/** RFC 28's outcome table. Only a matching attestation together with the
 * stream's evidence proves either outcome; anything else is uncertain. */
export function classifyPiResume(
  verification: PiVerification,
  observed: PiResumeObservation,
): PiResumeOutcome {
  const attestation = readAttestation(verification);
  if (attestation?.outcome === "verified" && observed.completed && observed.agentEvents)
    return { kind: "verified" };
  if (attestation?.outcome === "refused" && observed.nativeExit3 && !observed.agentEvents)
    return { kind: "refused", reason: attestation.reason };
  return {
    kind: "uncertain",
    detail:
      attestation === null
        ? "no matching attestation"
        : `attestation ${attestation.outcome} did not match the run`,
  };
}
