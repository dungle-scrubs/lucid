import type { AgentProgress } from "../protocol/wire.ts";

/** Upper bound on a self-reported phase label (see sanitizeProgress). */
const LABEL_MAX = 200;

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
  // Bounded: the label is a one-liner under a working indicator, rides every
  // ack and every heartbeat frame, and lives in log.ndjson forever. An agent
  // that pastes a paragraph gets its first line's worth, not a refusal - a
  // stalled narration is worse than a clipped one.
  const label =
    typeof p.label === "string" && p.label.length > 0 ? p.label.slice(0, LABEL_MAX) : undefined;
  const total = count(p.total);
  const done = count(p.done);
  if (label === undefined && total === undefined && done === undefined) return undefined;
  return {
    ...(label ? { label } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(done !== undefined ? { done } : {}),
  };
};

/**
 * Canonical validation for a `blocked` reason, applied at both delivery
 * boundaries like `sanitizeProgress`. One line, bounded the same way: it rides
 * every ack, renders where a spinner would be, and lives in the log forever.
 * Empty (or non-string) means "not blocked", which is how an ordinary ack
 * clears the flag.
 */
export const sanitizeBlocked = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined;
  const line = input.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return line.length > 0 ? line : undefined;
};
