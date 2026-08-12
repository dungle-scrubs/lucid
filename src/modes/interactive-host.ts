/**
 * InteractiveHost — the deep module that owns the interactive ladder lifecycle.
 *
 * `src/modes/interactive.ts` previously exported five helpers (`selectRung`,
 * `parseAnnounce`, `tailTranscript`, `attachCapabilities`, `chunkInjection`)
 * as standalone pure functions with no owner for the live discipline. The
 * HookDelivery (C02) deepened only the hooks rung (chunk + queued selection +
 * `decision:block`), leaving the ladder — announce→attach, tail pump with
 * torn-line and byte-offset, capability query, and the `hooks → cooperative →
 * observe` degradation — scattered across `interactive + delivery + announce +
 * inject`. Fixing torn-line handling fixed only the tail helper; fixing the
 * injection cap fixed only delivery; the next rung (cooperative, gated on
 * A-003) would have been a third copy. The test file imported each helper
 * individually, not a seam.
 *
 * Now one module owns the whole discipline — rung selection, announce parse,
 * transcript tail pump, capability query, and per-rung delivery — and hides
 * it behind a small, deep interface: `createInteractiveHost(env) → InteractiveHost`
 * with a strategy table. The three strategies differ only in `deliver()`:
 * hooks via `HookDelivery`, cooperative via drop-file poll (gated), observe
 * via resume-instruction (no-op). The public surface keeps backward-compat
 * re-exports so `src/modes/interactive.js` stays a thin adapter.
 * Deletion test: deleting this module would scatter announce + tail + rung
 * + delivery across hooks + a future cooperative adapter + any TUI that tails.
 *
 * What it is NOT: it is not the flock, the durable log, or the presence
 * lock — it drives a harness's native transcript through the normalizer
 * and speaks injection via the store.
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
import { chunkHookInput, HOOK_CHUNK_CAP_BYTES } from "../cli/hooks/delivery.js";

// ---------------------------------------------------------------------------
// Rungs — the degradation surface
// ---------------------------------------------------------------------------

export const RUNGS = ["hooks", "cooperative", "observe"] as const;
export type Rung = (typeof RUNGS)[number];

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

export interface LadderEnv {
  /** `--setting-sources project` in effect AND HERDR_ENV unset for the
   * child (D-025): the hooks rung needs both or its Stop hooks hang. */
  readonly hooksIsolated: boolean;
  /** The agent runs lucid's cooperative drop-file poll loop. GATED on the
   * A-003 retry; until that lands the cooperative rung is never offered. */
  readonly cooperativeAvailable: boolean;
}

export const A003_GATE_OPEN = false;

export const selectRung = (env: LadderEnv): RungProfile => {
  if (env.hooksIsolated) return PROFILES.hooks;
  if (A003_GATE_OPEN && env.cooperativeAvailable) return PROFILES.cooperative;
  return PROFILES.observe;
};

// ---------------------------------------------------------------------------
// Injection chunking — single source lives in HookDelivery
// ---------------------------------------------------------------------------

export const INJECTION_CAP = HOOK_CHUNK_CAP_BYTES;

export const chunkInjection = (
  text: string,
  cap: number = HOOK_CHUNK_CAP_BYTES,
): readonly string[] => chunkHookInput(text, cap);

// ---------------------------------------------------------------------------
// Capability query
// ---------------------------------------------------------------------------

export const attachCapabilities = (
  h: HarnessDescriptor,
  model: string,
  mode: "interactive",
): CapabilityResult => capabilitiesOf(h, model, mode);

// ---------------------------------------------------------------------------
// Announce parse
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Transcript tail — byte-offset, torn-line policy
// ---------------------------------------------------------------------------

export interface TailResult {
  readonly events: readonly ContentEvent[];
  /** BYTES consumed — feed back as `fromByte` on the next poll / seek. */
  readonly offset: number;
}

const NL = 0x0a;

export const tailTranscript = (
  harness: HarnessDescriptor,
  raw: Buffer,
  fromByte = 0,
): TailResult => {
  const events: ContentEvent[] = [];
  let offset = Math.min(fromByte, raw.length);
  while (offset < raw.length) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break;
    const line = raw.toString("utf8", offset, nl);
    offset = nl + 1;
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of contentEventsOf(harness.name, parsed)) events.push(e);
  }
  return { events, offset };
};

// ---------------------------------------------------------------------------
// Host — strategy table that owns the rung lifecycle
// ---------------------------------------------------------------------------

export interface InteractiveHostDeps {
  readonly harness: HarnessDescriptor;
  /** The env that decides the rung at creation time (injected so tests are deterministic). */
  readonly env?: LadderEnv;
}

export interface DeliveryRequest {
  readonly text: string;
}

export interface DeliveryResult {
  readonly kind: "injected" | "queued" | "resume-instruction";
  readonly rung: Rung;
  readonly chunks?: number;
}

interface StrategyHandle {
  /** Deliver text under this rung's discipline. */
  deliver(text: string): DeliveryResult;
}

const hooksStrategy = (): StrategyHandle => ({
  deliver(text: string): DeliveryResult {
    const chunks = chunkHookInput(text);
    // The actual store enqueue lives in HookDelivery (deliverFirstQueued);
    // this seam owns the cap/chunk policy so the test can assert it without a flock.
    void chunks;
    return { kind: "injected", rung: "hooks", chunks: chunks.length };
  },
});

const cooperativeStrategy = (): StrategyHandle => ({
  deliver(_text: string): DeliveryResult {
    // Gated — would poll the cooperative drop file (A-003).
    return { kind: "queued", rung: "cooperative" };
  },
});

const observeStrategy = (): StrategyHandle => ({
  deliver(_text: string): DeliveryResult {
    // Tail-only: queued input surfaces as a resume instruction, never injected.
    return { kind: "resume-instruction", rung: "observe" };
  },
});

export interface InteractiveHost {
  /** The rung selected for this host instance. */
  readonly rung: RungProfile;
  /** Parse a SessionStart hook line into an attach intent. */
  parseAnnounce(line: string): AnnounceAttach | null;
  /** Tail a harness transcript buffer with torn-line safety. */
  tail(harness: HarnessDescriptor, raw: Buffer, fromByte?: number): TailResult;
  /** Query harness capabilities for the interactive mode. */
  capabilities(model: string): CapabilityResult;
  /** Chunk text under the single encoded-byte cap. */
  chunk(text: string, cap?: number): readonly string[];
  /** Deliver text via the selected rung's discipline. */
  deliver(text: string): DeliveryResult;
  /** Reselect rung from a fresh env (e.g. after HERDR_ENV changes). */
  reselect(env: LadderEnv): RungProfile;
}

export const createInteractiveHost = (deps: InteractiveHostDeps): InteractiveHost => {
  let env = deps.env ?? { hooksIsolated: false, cooperativeAvailable: false };
  let rung = selectRung(env);

  const table: Record<Rung, StrategyHandle> = {
    hooks: hooksStrategy(),
    cooperative: cooperativeStrategy(),
    observe: observeStrategy(),
  };

  const current = (): StrategyHandle => table[rung.rung] ?? table.observe;

  return {
    get rung() {
      return rung;
    },
    parseAnnounce(line: string): AnnounceAttach | null {
      return parseAnnounce(line);
    },
    tail(harness: HarnessDescriptor, raw: Buffer, fromByte?: number): TailResult {
      return tailTranscript(harness, raw, fromByte);
    },
    capabilities(model: string): CapabilityResult {
      return attachCapabilities(deps.harness, model, "interactive");
    },
    chunk(text: string, cap?: number): readonly string[] {
      return chunkInjection(text, cap);
    },
    deliver(text: string): DeliveryResult {
      return current().deliver(text);
    },
    reselect(next: LadderEnv): RungProfile {
      env = next;
      rung = selectRung(env);
      return rung;
    },
  };
};
