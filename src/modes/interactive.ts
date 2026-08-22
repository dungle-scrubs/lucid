/**
 * Interactive adapter — thin façade over the deep `InteractiveHost`.
 *
 * The ladder discipline (rung selection, announce→attach, tail pump with
 * torn-line + byte-offset, capability query, and per-rung delivery) now
 * lives in `src/modes/interactive-host.ts` behind a strategy table. This
 * file preserves the original import path (`src/modes/interactive.js`) so
 * tests and callers keep their seam without retargeting, while the deep
 * module is the single owner. The deletion test: deleting this file would
 * require only import-path updates; adding the cooperative rung or fixing
 * torn-line handling requires touching only the host.
 *
 * What it is NOT: it is not the durable log, the flock, or the presence
 * lock — it drives the harness's native transcript through the normalizer.
 */

// Host is the single owner; this adapter re-exports the seam.
export {
  A003_GATE_OPEN,
  type AnnounceAttach,
  attachCapabilities,
  chunkInjection,
  createInteractiveHost,
  type DeliveryRequest,
  type DeliveryResult,
  INJECTION_CAP,
  type InteractiveHost,
  type InteractiveHostDeps,
  type LadderEnv,
  parseAnnounce,
  RUNGS,
  type Rung,
  type RungProfile,
  selectRung,
} from "./interactive-host.js";
