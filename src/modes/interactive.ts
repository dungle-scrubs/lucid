/**
 * The interactive adapter LADDER for a human-owned harness process lucid
 * does not own (PLAN 4.4 / D-017). Three rungs in descending capability:
 *
 *   rung 1  hooks       observe transcript messages; inject at tool
 *                       boundaries; lucid-aware attach via SessionStart.
 *                       Needs `--setting-sources project` and HERDR_ENV
 *                       unset for the child (D-025).
 *   rung 2  cooperative observe; deliver by wait-poll (the agent checks a
 *                       drop file). [GATED on the A-003 retry.]
 *   rung 3  observe     tail only; queued input surfaces as a resume
 *                       instruction, never injected. [GATED on A-003.]
 *
 * This module owns the rung-1 LOGIC that fixtures can prove - transcript
 * tail parsing (resume-safe by byte offset), injection chunking under a
 * cap, the capability query at attach, and the degradation order - plus
 * the ladder's rung selection. The injection CONTRACT (that a boundary
 * hook actually delivers) is proven only by the live-pty smoke, not here
 * (fixtures cannot prove injection - MUSE F10). NOT responsible for
 * spawning (the human owns the process) or for protocol enforcement (the
 * store hosts the reducer); this is a source that maps a tailed
 * transcript into event frames and a queued input into a boundary
 * injection with a disposition.
 */

import {
  type CapabilityResult,
  capabilitiesOf,
} from "@dungle-scrubs/harness-cli/src/interpretation/capabilities.js";
import {
  type ContentEvent,
  contentEventsOf,
} from "@dungle-scrubs/harness-cli/src/interpretation/content.js";
import { asRecord } from "@dungle-scrubs/harness-cli/src/interpretation/shape.js";
import type { HarnessDescriptor } from "@dungle-scrubs/harness-cli/src/knowledge/descriptor.js";
import { chunkHookInput as _chunkHookInput, HOOK_CHUNK_CAP_BYTES } from "../cli/hooks/delivery.js";

/** The rungs in descending capability; selection walks this order. */
export const RUNGS = ["hooks", "cooperative", "observe"] as const;
export type Rung = (typeof RUNGS)[number];

/** What a rung can do - the degradation surface. */
export interface RungProfile {
  readonly rung: Rung;
  /** How queued input reaches the agent. */
  readonly inject: "boundary" | "wait-poll" | "resume-instruction";
  /** Whether lucid can announce identity/attach without agent cooperation. */
  readonly attach: "lucid-aware" | "cooperative" | "none";
}

const PROFILES: Record<Rung, RungProfile> = {
  hooks: { rung: "hooks", inject: "boundary", attach: "lucid-aware" },
  cooperative: { rung: "cooperative", inject: "wait-poll", attach: "cooperative" },
  observe: { rung: "observe", inject: "resume-instruction", attach: "none" },
};

/** The environment facts that decide which rungs are reachable. A rung is
 * only offered if its preconditions hold; the ladder picks the highest. */
export interface LadderEnv {
  /** `--setting-sources project` in effect AND HERDR_ENV unset for the
   * child (D-025): the hooks rung needs both or its Stop hooks hang. */
  readonly hooksIsolated: boolean;
  /** The agent runs lucid's cooperative drop-file poll loop. GATED on the
   * A-003 retry; until that lands the cooperative rung is never offered. */
  readonly cooperativeAvailable: boolean;
}

/** Rungs 2-3 are gated on the A-003 retry (deferred). Until it lands, the
 * ladder offers rung 1 when isolated and otherwise falls straight to
 * observe-only - the cooperative rung is never selected. */
export const A003_GATE_OPEN = false;

/** Pick the highest reachable rung. Degradation is strict order: hooks ->
 * cooperative -> observe, each gated by its preconditions. observe always
 * works (tail is always possible), so selection never fails. */
export const selectRung = (env: LadderEnv): RungProfile => {
  if (env.hooksIsolated) return PROFILES.hooks;
  if (A003_GATE_OPEN && env.cooperativeAvailable) return PROFILES.cooperative;
  return PROFILES.observe;
};

/**
 * The hook injection cap — the `reason` field limit (A-004). The
 * single source of truth lives in `src/cli/hooks/delivery.ts`
 * (`HOOK_CHUNK_CAP_BYTES`, measured in encoded UTF-8 bytes); this
 * alias keeps the interactive adapter's existing import path while the
 * metric and cap converge (C02).
 */
export const INJECTION_CAP = HOOK_CHUNK_CAP_BYTES;

/** Split an injected message into ordered chunks — delegates to the
 * deep `HookDelivery` chunker so surrogate safety and the encoded-byte
 * metric apply uniformly. Preserves the original `cap`-by-caller
 * signature for backward compat; the cap is still validated. */
export const chunkInjection = (
  text: string,
  cap: number = HOOK_CHUNK_CAP_BYTES,
): readonly string[] => _chunkHookInput(text, cap);

/** Query the harness's capabilities at attach: runtime-verified when the
 * registry knows the model, degrading to curated/unknown otherwise
 * (D-008). A thin pass-through so the adapter never re-derives the policy
 * the normalizer owns. */
export const attachCapabilities = (
  h: HarnessDescriptor,
  model: string,
  mode: "interactive",
): CapabilityResult => capabilitiesOf(h, model, mode);

/** A SessionStart hook payload (from the harness) parsed into lucid's
 * attach intent: identity + where to tail, delivered with zero agent
 * cooperation (A-002 confirmed). The adapter turns this into an attach
 * frame; this function is the pure parse the fixture can prove. */
export interface AnnounceAttach {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly source: string;
}

export const parseAnnounce = (line: string): AnnounceAttach | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  // JSON.parse("null") / a bare primitive parses fine but is not a record;
  // narrow before touching fields so a truncated hook line is skipped, not
  // a thrown TypeError.
  const row = asRecord(parsed);
  if (
    row === null ||
    row.hook !== "SessionStart" ||
    typeof row.session_id !== "string" ||
    row.session_id === "" ||
    typeof row.transcript_path !== "string" ||
    row.transcript_path === ""
  )
    return null;
  return {
    sessionId: row.session_id,
    transcriptPath: row.transcript_path,
    source: typeof row.source === "string" ? row.source : "unknown",
  };
};

/** The forwarded content events plus the BYTE offset AFTER the last
 * complete line, so a restarted adapter fs-seeks to exactly where it
 * stopped - no dupes. Byte-accurate (the file is bytes; a UTF-16 offset
 * would desync a seek on any non-ASCII transcript). */
export interface TailResult {
  readonly events: readonly ContentEvent[];
  /** BYTES consumed - feed back as `fromByte` on the next poll / seek. */
  readonly offset: number;
}

const NL = 0x0a;

/** Parse whole transcript lines from byte `fromByte`, delegating record
 * decoding to the normalizer (which OWNS the per-harness transcript
 * vocabulary - lucid re-deriving it would drift and would be claude-only).
 * lucid owns only the offset/torn-line policy: a torn trailing line (the
 * writer is mid append) is left unconsumed so the next poll re-reads it
 * whole, and the byte offset advances only past complete lines - that is
 * what makes restart dupe-free. */
export const tailTranscript = (
  harness: HarnessDescriptor,
  raw: Buffer,
  fromByte = 0,
): TailResult => {
  const events: ContentEvent[] = [];
  let offset = Math.min(fromByte, raw.length);
  while (offset < raw.length) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break; // torn trailing line: leave for the next poll
    const line = raw.toString("utf8", offset, nl);
    offset = nl + 1;
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a non-JSON transcript line is not our concern; skip it
    }
    // asRecord inside contentEventsOf guards non-object rows (null,
    // primitives) - a bad line yields zero events, never a throw.
    for (const e of contentEventsOf(harness.name, parsed)) events.push(e);
  }
  return { events, offset };
};
