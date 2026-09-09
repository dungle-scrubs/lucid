import { stripVTControlCharacters } from "node:util";
import manifest from "../../package.json";
import { CompatibilityError, compatibilityMessage } from "../protocol/compatibility.js";
import type { HarnessFacts } from "./runner.js";
import { belowFloor, HCN_MIN_VERSION } from "./version.js";

export const HCN_PIN = manifest.dependencies["@dungle-scrubs/harness-cli-normalizer"];

import type { CompatibilityDiagnostic, HcnInstallation } from "../protocol/compatibility.js";

export type { CompatibilityDiagnostic, HcnInstallation } from "../protocol/compatibility.js";

export function safeFact(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    stripVTControlCharacters(value)
      .replace(/\p{Cc}/gu, "")
      .slice(0, 1024)
      .trim() || null
  );
}

export function versionIdentity(value: string | null): string | null {
  const normalized = value?.trim().replace(/^v/, "");
  const core = "(0|[1-9][0-9]*)";
  const pre = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const syntax = new RegExp(
    `^${core}\\.${core}\\.${core}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  );
  return normalized && syntax.test(normalized) ? normalized : null;
}

export function hcnDiagnostic(
  installation: HcnInstallation,
  origin: CompatibilityDiagnostic["origin"] = "runtime-start",
  failure?: string,
): CompatibilityDiagnostic | null {
  const detected = versionIdentity(installation.detected);
  const hcn = safeInstallation(installation);
  const old = installation.detected !== null && belowFloor(installation.detected);
  if (!failure && !old && detected !== null && detected === versionIdentity(hcn.pin)) return null;
  const prefix = observationPrefix(origin);
  const message = old
    ? `${prefix}, selected HCN reported ${detected ?? "an unknown version"}, below the ${hcn.minimum} minimum for managed agent work.`
    : failure || detected === null
      ? `${prefix}, HCN inspection is unavailable for managed agent work: ${failure ?? "the version response was malformed"}.`
      : `${prefix}, selected HCN reports ${detected}; this Lucid release pins ${hcn.pin}. This difference alone does not block agent work.`;
  return {
    code: old
      ? "hcn-version-too-old"
      : failure || detected === null
        ? "inspection-unavailable"
        : "hcn-version-drift",
    harness: null,
    hcn,
    message,
    observedAt: new Date().toISOString(),
    operation: "starting managed agent work",
    origin,
    remedy: installationRemedy(hcn),
    scope: "runtime",
    severity: old || failure ? "error" : "warning",
  };
}

export function diagnosticMessage(diagnostic: CompatibilityDiagnostic): string {
  return compatibilityMessage(diagnostic);
}

export function safeInstallation(installation: HcnInstallation): HcnInstallation {
  return {
    ...installation,
    detected: versionIdentity(installation.detected),
    lookupRoot: safeFact(installation.lookupRoot),
    path: safeFact(installation.path),
    source: safeFact(installation.source),
  };
}

function observationPrefix(origin: CompatibilityDiagnostic["origin"]): string {
  switch (origin) {
    case "runtime-start":
      return "At Lucid startup";
    case "selection-check":
      return "When this driver selection was checked";
    case "session-handshake":
      return "During the session handshake";
    case "execution-check":
      return "When this attempt was checked";
  }
}

export const unknownInstallation: HcnInstallation = {
  detected: null,
  lookupRoot: null,
  minimum: HCN_MIN_VERSION,
  path: null,
  pin: HCN_PIN,
  source: null,
};

function operationLabel(choice: { readonly harness: string; readonly model?: string }): string {
  return `starting ${safeFact(choice.harness) ?? "selected harness"}${choice.model ? ` with model ${safeFact(choice.model) ?? "unknown"}` : ""}`;
}

export function selectionProblem(
  choice: { readonly harness: string; readonly model?: string },
  installation: HcnInstallation = unknownInstallation,
  code: "inspection-unavailable" | "selection-unsupported" = "inspection-unavailable",
  detail = "harness inspection is unavailable",
  origin: CompatibilityDiagnostic["origin"] = "selection-check",
): CompatibilityDiagnostic {
  installation = safeInstallation(installation);
  const operation = operationLabel(choice);
  return {
    code,
    harness: {
      admissionVerified: null,
      detected: null,
      name: safeFact(choice.harness),
      path: null,
      verified: null,
    },
    hcn: installation,
    message: `${observationPrefix(origin)}, ${operation}: ${safeFact(detail)}.`,
    observedAt: new Date().toISOString(),
    operation,
    origin,
    remedy: `Check the selected model, profile, and installed harness. New-model support can require an HCN and Lucid update when available. ${installationRemedy(installation)}`,
    scope: "selection",
    severity: "error",
  };
}

export function failureDiagnostic(error: unknown): CompatibilityDiagnostic | undefined {
  return error instanceof CompatibilityError ? error.diagnostic : undefined;
}

export function refusalDetail(issue: unknown): string {
  return issue === "no-session-mode"
    ? "HCN reports no persistent headless session mode for this harness (no-session-mode)"
    : `HCN refused this selection (${safeFact(issue) ?? "unspecified reason"})`;
}

export function selectionDiagnostic(
  facts: HarnessFacts,
  choice: { readonly harness: string; readonly model?: string },
  installation: HcnInstallation = unknownInstallation,
  origin: CompatibilityDiagnostic["origin"] = "selection-check",
  admission?: boolean,
): CompatibilityDiagnostic | null {
  installation = safeInstallation(installation);
  const detected = safeFact(facts.runtime?.executable.version);
  const verified = safeFact(facts.runtime?.verifiedAgainst);
  const admissionVerified = admission === undefined ? null : safeFact(facts.verifiedAgainst);
  const path = safeFact(facts.runtime?.executable.path);
  const inconsistent =
    admissionVerified !== null && verified !== null && admissionVerified !== verified;
  if (detected !== null && path !== null && detected === verified && !inconsistent) return null;
  const operation = operationLabel(choice);
  const prefix = observationPrefix(origin);
  const reason = inconsistent
    ? `runtime inspection verifies ${verified}, while admission requires ${admissionVerified}; the existing admission check ${admission ? "passed" : "refused the operation"}`
    : detected === null || verified === null || path === null
      ? "harness executable or verified-version evidence is unavailable"
      : `the selected executable reports ${detected}, but HCN verifies ${verified}; this executable is unverified`;
  return {
    code:
      inconsistent || detected === null || verified === null || path === null
        ? "inspection-unavailable"
        : "harness-version-unverified",
    harness: { admissionVerified, detected, name: safeFact(choice.harness), path, verified },
    hcn: installation,
    message: `${prefix}, ${operation}: ${reason}.`,
    observedAt: new Date().toISOString(),
    operation,
    origin,
    remedy: `Align the selected harness with HCN's verified version. Newer harness support can require an HCN and Lucid update when available. ${installationRemedy(installation)}`,
    scope: "selection",
    severity: admission === false ? "error" : "warning",
  };
}

export function installationRemedy(installation: HcnInstallation): string {
  const target = installation.path ?? "the selected HCN executable";
  switch (installation.source) {
    case "package-dependency":
      return `Repair or update Lucid and its pinned HCN dependency at ${target}. Restart Lucid and try again.`;
    case "env":
      return `Repair the LUCID_HCN override at ${target}, or correct the override. Restart Lucid and try again.`;
    case "node_modules":
    case "node_modules(executable)":
    case "node_modules(cwd)":
      return `Repair HCN in ${installation.lookupRoot ?? target} (selected executable: ${target}). Restart Lucid and try again.`;
    case "path":
      return `Repair the HCN selected through PATH at ${target}. Restart Lucid and try again.`;
    default:
      return `Repair ${target}. Restart Lucid and try again.`;
  }
}
