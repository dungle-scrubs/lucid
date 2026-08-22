/**
 * InteractiveHost — the deep module that owns the interactive ladder
 * AND the hook injection discipline (01).
 *
 * Before (C02 + ladder deepening), the ladder — announce→attach, tail pump
 * capability query, and the `hooks →
 * cooperative → observe` degradation — lived in `interactive-host.ts`
 * behind a strategy table, while the durable hook pipeline — `guard →
 * queued selection → encoded-byte chunk (cap 4000, surrogate-safe) →
 * enqueue(steer) per chunk → decision:block → HERDR_ENV isolation` — lived
 * in `src/cli/hooks/delivery.ts` (HookDelivery). Fixing the cap fixed
 * only delivery; fixing rung selection fixed only the host; the next
 * rung (cooperative, gated on A-003) would have been a third copy and
 * the future `Stop` hook a fourth copy of `guard + chunk`. The test file
 * imported each helper individually, not a seam, and `delivery` and `host`
 * re-exported each other's constant via a cycle
 * (`interactive-host → delivery → chunkHookInput`, `delivery → host` would-be).
 *
 * Now one module owns the whole discipline — rung selection, announce
 * parse, capability query, per-rung delivery,
 * AND the single encoded-byte chunk metric, the single cap, surrogate
 * safety, the stdin guard (`JSON + LUCID_RECORD_DIR` verification via
 * `resolveVerifiedRecord`), queued-input selection, chunked
 * `enqueueInput(steer)` per chunk, `decision:block` stdout, and
 * `HERDR_ENV` isolation — and hides it behind a small, deep interface:
 * `createInteractiveHost(env) → InteractiveHost` plus the durable hook
 * helpers `guardHookEntry` / `readQueuedInputs` / `deliverFirstQueued`
 * and the single chunker `chunkHookInput` / `encodedByteLength`. The
 * hooks (`announce`/`inject`/future `Stop`) and `interactive.ts` become
 * thin adapters. Deletion test: deleting this module would scatter
 * `selectRung + parseAnnounce + chunk + guard + queued
 * + steer-per-chunk + decision:block + HERDR_ENV` across every hook and
 * the interactive adapter.
 *
 * What it is NOT: it is not the flock, the durable log, or the presence
 * lock — it drives a harness's native transcript through the normalizer
 * and speaks injection via the store.
 */

import { resolveVerifiedRecord, type VerifiedRecord } from "../cli/record-addressing.js";
import type { CapabilityResult, HarnessName, HarnessRunner } from "../harness/runner.js";
import { openConversation, viewConversation } from "../store/store.js";

// ---------------------------------------------------------------------------
// Hook chunking + guard — single source (was HookDelivery, now here)
// ---------------------------------------------------------------------------

/** The hook `reason` field cap — encoded UTF-8 bytes post-JSON-escape. */
export const HOOK_CHUNK_CAP_BYTES = 4000;

/**
 * Measure the UTF-8 byte length of `text` after JSON-escaping (the cap
 * is post-JSON-escape, not code points). The surrounding JSON quotes are
 * stripped.
 */
export const encodedByteLength = (text: string): number =>
  Buffer.byteLength(JSON.stringify(text), "utf8") - 2;

/**
 * Chunk `text` into pieces each measuring ≤ `cap` encoded bytes.
 * Greedy, code-point safe (never splits a surrogate pair), and
 * tolerant of a single code point that alone exceeds the cap (emitted
 * solo rather than looping forever). An empty input yields `[""]` so
 * its disposition remains real.
 *
 * This is the ONE chunker the codebase uses for hook delivery. The old
 * `chunkInput` (bytes + UTF-16 slice, inject.ts) and `chunkInjection`
 * (chars + code-point slice, interactive.ts) both delegated here via a
 * cycle — now one constant, one metric, and surrogate safety is uniform.
 */
export const chunkHookInput = (
  text: string,
  cap: number = HOOK_CHUNK_CAP_BYTES,
): readonly string[] => {
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("hook chunk cap must be a positive safe integer");
  if (encodedByteLength(text) <= cap) return [text];
  const points = [...text];
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const point of points) {
    const pointBytes = encodedByteLength(point);
    if (pointBytes > cap) {
      if (chunk.length > 0) {
        chunks.push(chunk);
        chunk = "";
        chunkBytes = 0;
      }
      chunks.push(point);
      continue;
    }
    if (chunkBytes + pointBytes > cap) {
      chunks.push(chunk);
      chunk = point;
      chunkBytes = pointBytes;
    } else {
      chunk += point;
      chunkBytes += pointBytes;
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
};

/** Backward-compat aliases so existing callers keep importing from here. */
export const chunkInput = chunkHookInput;
export const CHUNK_CAP_BYTES = HOOK_CHUNK_CAP_BYTES;

export type HookGuard =
  | { readonly proceed: true; readonly record: VerifiedRecord; readonly payload: unknown }
  | { readonly proceed: false; readonly result: { readonly ok: true } }
  | {
      readonly proceed: false;
      readonly result: {
        readonly ok: false;
        readonly code: "hook-resolution-failed";
        readonly message: string;
      };
    };

/**
 * Guard the hook entry: JSON-parse the stdin payload and resolve the
 * verified record via the env-stamp. Returns `proceed:false` for
 * misfires (non-JSON) and unmanaged sessions (no stamp) — both are
 * non-destructive no-ops — or for resolution failures (E003).
 * Callers become 5-line adapters: `if (!guard.proceed) return guard.result`.
 */
export const guardHookEntry = (stdin: string): HookGuard => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { proceed: false, result: { ok: true } };
  }
  const resolved = resolveVerifiedRecord();
  if ("notManaged" in resolved) return { proceed: false, result: { ok: true } };
  if (!resolved.ok)
    return {
      proceed: false,
      result: { ok: false, code: resolved.code, message: resolved.message },
    };
  return { proceed: true, record: resolved.record, payload };
};

export interface HookDeliverResult {
  readonly ok: boolean;
  readonly delivered?: number;
  readonly chunks?: number;
  readonly code?: "hook-resolution-failed" | "injection-refused";
  readonly message?: string;
}

/** Read the durable queue: outstanding/queued inputs in seq order. */
export const readQueuedInputs = (recordDir: string): readonly { id: string; text: string }[] => {
  const view = viewConversation(recordDir);
  return view.transcript.inputs
    .filter((inp) => inp.status === "outstanding" || inp.status === "queued")
    .map((inp) => ({ id: inp.id, text: inp.text }));
};

/**
 * Deliver the oldest queued input, chunked under the hook cap, via
 * `enqueueInput(steer)` per chunk. On success writes the A-002-proven
 * `{decision:"block", reason}` to `process.stdout` (hook output
 * composition is the hook runner's job — we emit only our decision).
 * On per-chunk refusal reports E004 without blind retry. Handles
 * HERDR_ENV isolation here so callers don't re-derive it.
 */
export const deliverFirstQueued = (recordDir: string): HookDeliverResult => {
  let queued: readonly { id: string; text: string }[];
  try {
    queued = readQueuedInputs(recordDir);
  } catch {
    return { ok: true };
  }
  if (queued.length === 0) return { ok: true };
  const first = queued[0];
  if (!first) return { ok: true };
  const chunks = chunkHookInput(first.text);
  // D-025: HERDR_ENV must be unset for the child the hook will spawn.
  delete process.env.HERDR_ENV;
  try {
    const host = openConversation(recordDir, {
      now: () => Date.now(),
      presence: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as string;
      const res = host.enqueueInput({
        id: `${first.id}-chunk-${i}`,
        text: chunk,
        mode: "steer",
      });
      if (res.verdict === "refused") {
        const issue = "issue" in res ? String((res as { issue: string }).issue) : "unknown";
        return { ok: false, code: "injection-refused", message: `disposition: ${issue}` };
      }
    }
    const reason = `HUMAN FEEDBACK: ${first.text.slice(0, 200)}`;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    return { ok: true, delivered: 1, chunks: chunks.length };
  } catch (e) {
    if (e instanceof Error && /lock-timeout|lock-unavailable/.test(e.message)) {
      return { ok: false, code: "hook-resolution-failed", message: e.message };
    }
    throw e;
  }
};

// Re-export durable result under the legacy name so `delivery.ts` can
// re-export it as `DeliverResult` without colliding with the rung
// `DeliveryResult` below. Host consumers that need the durable shape
// import `HookDeliverResult`; legacy `delivery.ts` consumers keep `DeliverResult`.
export type DeliverResultDurable = HookDeliverResult;

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
// Injection chunking — single source (now owned here)
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
  runner: HarnessRunner,
  harness: HarnessName,
  model: string,
): Promise<CapabilityResult> => runner.capabilities(harness, model, "interactive");

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
  const row =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
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
// Host — strategy table that owns the rung lifecycle
// ---------------------------------------------------------------------------

export interface InteractiveHostDeps {
  readonly harness: HarnessName;
  readonly runner: HarnessRunner;
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
  /** Query harness capabilities for the interactive mode. */
  capabilities(model: string): Promise<CapabilityResult>;
  /** Chunk text under the single encoded-byte cap. */
  chunk(text: string, cap?: number): readonly string[];
  /** Deliver text via the selected rung's discipline (speculative; durable hook enqueue lives in `deliverFirstQueued`). */
  deliver(text: string): DeliveryResult;
  /** Durable hook delivery: oldest queued input → chunked steer + decision:block (same cap/metric). Thin wrapper over the deep `deliverFirstQueued` so hosts own the policy. */
  deliverQueued(recordDir: string): HookDeliverResult;
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
    capabilities(model: string): Promise<CapabilityResult> {
      return attachCapabilities(deps.runner, deps.harness, model);
    },
    chunk(text: string, cap?: number): readonly string[] {
      return chunkInjection(text, cap);
    },
    deliver(text: string): DeliveryResult {
      return current().deliver(text);
    },
    deliverQueued(recordDir: string): HookDeliverResult {
      return deliverFirstQueued(recordDir);
    },
    reselect(next: LadderEnv): RungProfile {
      env = next;
      rung = selectRung(env);
      return rung;
    },
  };
};
