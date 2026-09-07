import { isAbsolute } from "node:path";

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
