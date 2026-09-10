import { isAbsolute } from "node:path";
import type { HarnessFacts } from "./runner";

/** Only the complete known declaration can select native headless handling. */
export function nativeContextManagement(value: unknown): HarnessFacts["nativeContextManagement"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind === "native-session-auto-compaction" &&
    Array.isArray(record.modes) &&
    record.modes.length === 1 &&
    record.modes[0] === "headless-turn"
  )
    return record.kind;
  return record.kind === "auto-compaction" &&
    Array.isArray(record.modes) &&
    record.modes.includes("headless-turn") &&
    record.modes.every(
      (mode) => mode === "headless-turn" || mode === "headless-session" || mode === "interactive",
    )
    ? "auto-compaction"
    : undefined;
}

export function inspectedExecutable(value: unknown): {
  readonly path: string | null;
} {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    path: typeof record.path === "string" && isAbsolute(record.path) ? record.path : null,
  };
}
