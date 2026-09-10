import { stripVTControlCharacters } from "node:util";
import type { CompatibilityDiagnostic, HcnInstallation } from "../protocol/compatibility.js";
import { CompatibilityError, compatibilityMessage } from "../protocol/compatibility.js";

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

export function installationProblem(
  installation: HcnInstallation = unknownInstallation,
  origin: CompatibilityDiagnostic["origin"] = "runtime-start",
  detail = "the selected executable could not be resolved",
): CompatibilityDiagnostic {
  return {
    v: 1,
    code: "inspection-unavailable",
    harness: null,
    hcn: safeInstallation(installation),
    message: `HCN is unavailable: ${safeFact(detail)}.`,
    observedAt: new Date().toISOString(),
    operation: "starting managed agent work",
    origin,
    remedy: "Check the selected executable and try again.",
    scope: "runtime",
    severity: "error",
  };
}

export function diagnosticMessage(diagnostic: CompatibilityDiagnostic): string {
  return compatibilityMessage(diagnostic);
}

export function safeInstallation(installation: HcnInstallation): HcnInstallation {
  return {
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
  lookupRoot: null,
  path: null,
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
    v: 1,
    code,
    harness: {
      name: safeFact(choice.harness),
      path: null,
    },
    hcn: installation,
    message: `${observationPrefix(origin)}, ${operation}: ${safeFact(detail)}.`,
    observedAt: new Date().toISOString(),
    operation,
    origin,
    remedy: "Check the selected settings and the reported operation failure, then try again.",
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
