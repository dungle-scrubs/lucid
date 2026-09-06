/** Hook input delivery and the vocabulary for selecting an interactive rung. */

import { resolveVerifiedRecord, type VerifiedRecord } from "../cli/record-addressing.js";
import { LockError } from "../store/flock.js";
import { openWriter, viewConversation } from "../store/store.js";

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
 * On per-chunk refusal reports E004 without blind retry.
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
  try {
    const host = openWriter(recordDir, { presence: () => true });
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
    if (e instanceof LockError) {
      return { ok: false, code: "hook-resolution-failed", message: e.message };
    }
    throw e;
  }
};

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
