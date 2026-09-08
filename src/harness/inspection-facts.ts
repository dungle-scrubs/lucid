import { isAbsolute } from "node:path";

/** Only the complete known declaration can select native headless handling. */
export function nativeContextManagement(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "auto-compaction" &&
    Array.isArray(record.modes) &&
    record.modes.includes("headless-turn") &&
    record.modes.every(
      (mode) => mode === "headless-turn" || mode === "headless-session" || mode === "interactive",
    )
  );
}

export function inspectedExecutable(value: unknown): {
  readonly path: string | null;
  readonly version: string | null;
} {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    path: typeof record.path === "string" && isAbsolute(record.path) ? record.path : null,
    version:
      typeof record.version === "string" && record.version.length > 0 ? record.version : null,
  };
}

export function verifiedExecutable(
  value: unknown,
  verifiedAgainst: unknown,
): { readonly path: string; readonly version: string } | null {
  const executable = inspectedExecutable(value);
  return executable.path !== null &&
    executable.version !== null &&
    executable.version === verifiedAgainst
    ? { path: executable.path, version: executable.version }
    : null;
}
