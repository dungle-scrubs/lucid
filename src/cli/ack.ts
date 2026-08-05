/**
 * The CLI's ack helper (M5.5): one function for every kind of agent_ack a
 * turn can deliver - intent, progress, blocked, covers. Each kind stamps
 * attendant and turn identically; sanitization is applied once, here.
 *
 * Extracted from run.ts where runIntent/runBlocked/runProgress/runWaitCli
 * each duplicated the same deliver + turnStamp + attendantStamp pattern.
 */
import { deliver } from "../core/deliver.ts";
import { sanitizeAttendant, type AttendantStamp } from "../core/events.ts";
import type { SessionPaths } from "../core/paths.ts";
import { sanitizeBlocked, sanitizeProgress } from "../core/progress.ts";
import type { AgentProgress } from "../protocol/wire.ts";
import { LUCID_ENV_FIELDS } from "../launch/env-stamp.ts";

/** Read the LUCID_TURN_ID env var through the shared table. */
const turnStamp = (): { readonly turnId?: string } => {
  const t = process.env[LUCID_ENV_FIELDS.turnId];
  return t && t.length > 0 ? { turnId: t.slice(0, 128) } : {};
};

/** Build the attendant provenance stamp from LUCID_* env vars, through the
 *  shared table (M5.5). Through the shared normalizer even though we authored
 *  it: the direct-append path bypasses the server, and the log's invariants
 *  must not depend on which writer was live. */
const attendantStamp = (
  harness?: string,
  live?: { readonly model?: string; readonly effort?: string },
): AttendantStamp | undefined => {
  const h = harness || process.env[LUCID_ENV_FIELDS.harness];
  const sessionId = process.env[LUCID_ENV_FIELDS.sessionId];
  if (!h && !sessionId) return undefined;
  const model = live?.model ?? process.env[LUCID_ENV_FIELDS.model];
  const effort = live?.effort ?? process.env[LUCID_ENV_FIELDS.effort];
  return sanitizeAttendant({
    harness: h || "agent",
    ...(sessionId ? { sessionId } : {}),
    cwd: process.cwd(),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(process.env[LUCID_ENV_FIELDS.trace] ? { trace: process.env[LUCID_ENV_FIELDS.trace] } : {}),
    ...(process.env[LUCID_ENV_FIELDS.sessionIdAuthority]
      ? { sessionIdAuthority: process.env[LUCID_ENV_FIELDS.sessionIdAuthority] }
      : {}),
    ...(process.env[LUCID_ENV_FIELDS.launchId]
      ? { launchId: process.env[LUCID_ENV_FIELDS.launchId] }
      : {}),
  });
};

/** The fields an ack can carry. At most one of these is set per call. */
export interface AckFields {
  readonly intent?: "revise" | "reply";
  readonly progress?: AgentProgress;
  readonly blocked?: string;
  readonly covers?: number;
}

/** Deliver an agent_ack with the given fields, stamping attendant and turn
 *  identically for every kind. Sanitization is applied once, here: callers
 *  pass pre-sanitized values (sanitizeProgress/sanitizeBlocked run in the
 *  command handlers before calling this). */
export const ack = async (
  paths: SessionPaths,
  fields: AckFields,
  stamp?: {
    readonly harness?: string;
    readonly live?: { readonly model?: string; readonly effort?: string };
  },
): Promise<void> => {
  const attendant = attendantStamp(stamp?.harness, stamp?.live);
  await deliver(paths, {
    t: "agent_ack",
    id: crypto.randomUUID(),
    ...turnStamp(),
    ...fields,
    ...(attendant ? { attendant } : {}),
  });
};

// Re-exported for run.ts callers that still build stamps directly (runWaitCli).
export { turnStamp, attendantStamp, sanitizeBlocked, sanitizeProgress };
