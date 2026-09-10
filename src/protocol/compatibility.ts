export interface HcnInstallation {
  readonly lookupRoot: string | null;
  readonly path: string | null;
  readonly source: string | null;
}

export interface CompatibilityDiagnostic {
  readonly v: 1;
  readonly code: "inspection-unavailable" | "selection-unsupported";
  readonly harness: {
    readonly name: string | null;
    readonly path: string | null;
  } | null;
  readonly hcn: HcnInstallation;
  readonly message: string;
  readonly observedAt: string;
  readonly operation: string;
  readonly origin: "runtime-start" | "selection-check" | "execution-check" | "session-handshake";
  readonly remedy: string;
  readonly scope: "runtime" | "selection";
  readonly severity: "warning" | "error";
}

export class CompatibilityError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: CompatibilityDiagnostic,
  ) {
    super(message);
  }
}

export function compatibilityText(value: string): string {
  // Stored diagnostics can predate terminal-output cleanup.
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: remove ANSI control sequences before plain-text projection
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\p{Cc}/gu, "")
      .slice(0, 4096)
  );
}

export function compatibilityMessage(diagnostic: CompatibilityDiagnostic): string {
  return compatibilityText(`${diagnostic.message} ${diagnostic.remedy}`);
}

export function parseCompatibilityDiagnostic(value: unknown): CompatibilityDiagnostic | undefined {
  const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 4096;
  const fact = (v: unknown): v is string | null =>
    v === null || (typeof v === "string" && v.length <= 1024);
  if (!object(value) || !object(value.hcn)) return undefined;
  const hcn = value.hcn;
  const harness = value.harness;
  if (
    value.v !== 1 ||
    !["inspection-unavailable", "selection-unsupported"].includes(String(value.code)) ||
    !["runtime-start", "selection-check", "execution-check", "session-handshake"].includes(
      String(value.origin),
    ) ||
    !["runtime", "selection"].includes(String(value.scope)) ||
    !["warning", "error"].includes(String(value.severity)) ||
    ![value.message, value.remedy, value.operation, value.observedAt].every(text) ||
    ![hcn.path, hcn.source, hcn.lookupRoot].every(fact) ||
    (harness !== null && (!object(harness) || ![harness.name, harness.path].every(fact)))
  )
    return undefined;
  const cleanFact = (value: unknown): string | null =>
    typeof value === "string" ? compatibilityText(value).slice(0, 1024) : null;
  return {
    v: 1,
    code: value.code as CompatibilityDiagnostic["code"],
    origin: value.origin as CompatibilityDiagnostic["origin"],
    scope: value.scope as CompatibilityDiagnostic["scope"],
    severity: value.severity as CompatibilityDiagnostic["severity"],
    message: compatibilityText(String(value.message)),
    remedy: compatibilityText(String(value.remedy)),
    operation: compatibilityText(String(value.operation)),
    observedAt: compatibilityText(String(value.observedAt)),
    hcn: {
      path: cleanFact(hcn.path),
      source: cleanFact(hcn.source),
      lookupRoot: cleanFact(hcn.lookupRoot),
    },
    harness:
      harness === null
        ? null
        : {
            name: cleanFact(harness.name),
            path: cleanFact(harness.path),
          },
  };
}
