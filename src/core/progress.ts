import type { AgentProgress } from "../protocol/wire.ts";

/**
 * Canonical validation for a self-reported fan-out `progress` payload, applied
 * at BOTH delivery boundaries: the CLI (`lucid progress`, whose no-daemon path
 * appends straight to the log) and the server ack handler (the live POST path).
 * Sharing it means neither path can smuggle a `-4` or a non-finite count into
 * the folded window. Counts are floored; negatives and non-numbers are dropped
 * (treated as unset) rather than trusted. Returns undefined when nothing usable
 * survives, so callers omit `progress` entirely.
 *
 * Note it does NOT enforce `done <= total`: `total` and `done` can arrive on
 * separate acks (start with `--total`, later bump `--done`), so the only place
 * that reliably sees both is the viewer, which clamps at render time.
 */
export const sanitizeProgress = (input: unknown): AgentProgress | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const p = input as Record<string, unknown>;
  const count = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const label = typeof p.label === "string" && p.label.length > 0 ? p.label : undefined;
  const total = count(p.total);
  const done = count(p.done);
  if (label === undefined && total === undefined && done === undefined) return undefined;
  return {
    ...(label ? { label } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(done !== undefined ? { done } : {}),
  };
};
