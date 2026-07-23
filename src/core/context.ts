import { readFile, writeFile } from "node:fs/promises";
import type { ContextUsage } from "../protocol/wire.ts";
import type { SessionPaths } from "./paths.ts";

/**
 * The context-usage sidecar: a single last-value file (overwritten each report)
 * rather than a log event, since the attending harness posts usage every turn
 * and it must never bloat the append-only log. Reported by the harness's
 * statusline - the only place the real number lives (the model cannot read its
 * own context usage) - and rendered as the header ring. Advisory, like the
 * attendant sidecar: a bad or missing file just means no ring.
 */

/**
 * Validate a raw usage report into a clean ContextUsage (without `at`, which the
 * writer stamps). Counts are floored; negatives/non-finite are dropped. `pct`
 * is clamped to 0..100, or derived from used/total when omitted. Returns
 * undefined when no fill fraction can be established, so callers report nothing
 * rather than a broken ring.
 */
export const sanitizeContext = (input: {
  pct?: unknown;
  used?: unknown;
  total?: unknown;
}): Omit<ContextUsage, "at"> | undefined => {
  const count = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const used = count(input.used);
  const total = count(input.total);
  const rawPct =
    typeof input.pct === "number" && Number.isFinite(input.pct) ? input.pct : undefined;
  const derived =
    used !== undefined && total !== undefined && total > 0 ? (used / total) * 100 : undefined;
  const pct = rawPct ?? derived;
  if (pct === undefined) return undefined;
  return {
    pct: Math.max(0, Math.min(100, pct)),
    ...(used !== undefined ? { used } : {}),
    ...(total !== undefined ? { total } : {}),
  };
};

export const writeContextSidecar = async (
  paths: SessionPaths,
  usage: ContextUsage,
): Promise<void> => {
  await writeFile(paths.contextSidecar, `${JSON.stringify(usage, null, 2)}\n`);
};

const isContextUsage = (v: unknown): v is ContextUsage =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ContextUsage).pct === "number" &&
  typeof (v as ContextUsage).at === "string";

/** Read the last-reported context usage, or undefined if none/unreadable. */
export const readContextSidecar = async (
  paths: SessionPaths,
): Promise<ContextUsage | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.contextSidecar, "utf8"));
    return isContextUsage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
