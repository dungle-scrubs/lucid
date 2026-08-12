/**
 * Hook delivery pipeline — the deep module that owns the hook entry
 * guard, queue selection, chunking, enqueue, and stdout decision (C02).
 *
 * Before, `inject.ts` chunked by encoded UTF-8 bytes (cap 4000, UTF-16
 * slicing) and `interactive.ts` chunked by code-point count (cap 10000,
 * code-point slicing) for the *same* hook `reason` limit (A-004). Fixing
 * surrogate safety fixed only one caller; the cap lived in two places
 * with two metrics. The delivery pipeline — `resolveVerifiedRecord →
 * viewConversation queued filter → chunk → enqueue(steer) per chunk →
 * decision:block stdout` — was smeared across both hooks plus the
 * interactive adapter, with copy-pasted stdin+notManaged guards and
 * copy-pasted `run*` stdin→exit(0) shells.
 *
 * Now one module owns the whole discipline. The hooks become thin
 * adapters over it, the chunk metric is one (encoded bytes, the wire
 * truth), the cap is one constant, and surrogate safety applies
 * everywhere. The deletion test passes: deleting this module would
 * scatter `encodedByteLength + chunk + queued selection + HERDR_ENV
 * isolation + decision:block` across every hook (including the future
 * Stop hook).
 *
 * What it is NOT: it does not know the flock primitive, the reducer
 * internals, or the transport codec beyond what the store exposes.
 */

import { openConversation, viewConversation } from "../../store/store.js";
import { resolveVerifiedRecord, type VerifiedRecord } from "../record-addressing.js";

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
 * (chars + code-point slice, interactive.ts) both delegate here now,
 * so A-004 moves one constant, one metric, and surrogate safety is
 * uniform.
 */
export const chunkHookInput = (
  text: string,
  cap: number = HOOK_CHUNK_CAP_BYTES,
): readonly string[] => {
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("hook chunk cap must be a positive safe integer");
  if (encodedByteLength(text) <= cap) return [text];
  // Empty text already handled: encodedByteLength("") === 0 ≤ cap → [""].
  // Non-empty but encoded length > cap: greedy by code point.
  const points = [...text];
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const point of points) {
    const pointBytes = encodedByteLength(point);
    // If a single code point alone exceeds the cap (e.g. a rare astral
    // that JSON-escapes large), flush the current chunk and emit this
    // point solo rather than spinning forever.
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

export interface DeliverResult {
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
export const deliverFirstQueued = (recordDir: string): DeliverResult => {
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

/** Read stdin fully as utf8 — the single place hook CLIs do it. */
export const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Emit the hook's stderr + exit(0) contract (non-destructive). */
export const exitHook = (result: {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
}): never => {
  if (!result.ok) {
    process.stderr.write(`${result.code ?? "hook-error"}: ${result.message ?? ""}\n`);
  }
  process.exit(0);
};
