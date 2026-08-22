/**
 * Hook delivery pipeline — thin adapter over the deep `InteractiveHost`.
 *
 * The durable hook discipline — `guard → queued selection → encoded-byte
 * chunk (cap 4000, surrogate-safe) → enqueue(steer) per chunk →
 * decision:block → HERDR_ENV isolation` — now lives in
 * `src/modes/interactive-host.ts` (01). This file preserves the original
 * import path (`./delivery.js`) so `announce`, `inject`, `dispatch`, and
 * tests keep their seam without retargeting, while the deep module is the
 * single owner. The deletion test: deleting `interactive-host.ts` would
 * scatter `encodedByteLength + chunk + guard + queued + steer-per-chunk +
 * decision:block` across every hook (including the future `Stop` hook);
 * deleting this file would require only import-path updates.
 *
 * What it is NOT: it is not the flock, the reducer, or the transport
 * codec beyond what the store exposes.
 */

// Backward-compat: legacy name for the durable deliver result. Host
// exports it as `HookDeliverResult`; this alias preserves `DeliverResult`
// for `inject.ts` and any direct `delivery.ts` importers.
export type { HookDeliverResult as DeliverResult } from "../../modes/interactive-host.js";
// Deep host is the single owner; this adapter re-exports the seam.
export {
  CHUNK_CAP_BYTES,
  chunkHookInput,
  chunkInput,
  deliverFirstQueued,
  encodedByteLength,
  guardHookEntry,
  HOOK_CHUNK_CAP_BYTES,
  type HookDeliverResult,
  type HookGuard,
  readQueuedInputs,
} from "../../modes/interactive-host.js";

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
