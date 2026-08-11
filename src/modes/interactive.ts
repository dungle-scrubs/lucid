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

import type { HarnessEvent } from "@dungle-scrubs/harness-cli/src/execution/events.js";
import {
  type CapabilityResult,
  capabilitiesOf,
} from "@dungle-scrubs/harness-cli/src/interpretation/capabilities.js";
import type { HarnessDescriptor } from "@dungle-scrubs/harness-cli/src/knowledge/descriptor.js";

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

/** The conservative injection cap (chars) pending the A-004 measurement,
 * which by its own impact note affects only this number and adapter
 * wording - no architecture. Named here so one edit moves it when A-004
 * lands. */
export const INJECTION_CAP = 10_000;

/** Split an injected message into ordered chunks no larger than the cap,
 * so a long human message survives the hook's reason-field limit (A-004).
 * Never splits an empty message into zero chunks - an empty input still
 * delivers one empty chunk so its disposition is real. */
export const chunkInjection = (text: string, cap: number = INJECTION_CAP): readonly string[] => {
  if (cap <= 0) throw new Error("injection cap must be positive");
  if (text.length <= cap) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += cap) chunks.push(text.slice(i, i + cap));
  return chunks;
};

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
  let row: {
    hook?: unknown;
    session_id?: unknown;
    transcript_path?: unknown;
    source?: unknown;
  };
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (
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

/** One parsed transcript message plus the byte offset AFTER it, so a
 * restarted adapter resumes from exactly where it stopped - no dupes. */
export interface TailResult {
  readonly events: readonly HarnessEvent[];
  /** Bytes consumed - feed back as `fromByte` on the next poll. */
  readonly offset: number;
}

interface TranscriptRow {
  readonly type?: string;
  readonly message?: { readonly role?: string; readonly content?: unknown };
}

/** Extract the plain text of an assistant message row (content is an array
 * of typed blocks; only text blocks render). */
const assistantText = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    )
      parts.push((block as { text: string }).text);
  }
  return parts.length === 0 ? null : parts.join("");
};

/** Parse whole transcript lines from `fromByte`, emitting a `message`
 * event per assistant text row. A torn trailing line (the writer is mid
 * append) is left unconsumed so the next poll re-reads it whole - the
 * offset only advances past complete lines, which is what makes restart
 * dupe-free. */
export const tailTranscript = (raw: string, fromByte = 0): TailResult => {
  const events: HarnessEvent[] = [];
  let offset = fromByte;
  while (offset < raw.length) {
    const nl = raw.indexOf("\n", offset);
    if (nl === -1) break; // torn trailing line: leave for the next poll
    const line = raw.slice(offset, nl);
    offset = nl + 1;
    if (line === "") continue;
    let row: TranscriptRow;
    try {
      row = JSON.parse(line) as TranscriptRow;
    } catch {
      continue; // a non-JSON transcript line is not our concern; skip it
    }
    if (row.type === "assistant" && row.message?.role === "assistant") {
      const text = assistantText(row.message.content);
      if (text !== null) events.push({ kind: "message", role: "assistant", text });
    }
  }
  return { events, offset };
};
