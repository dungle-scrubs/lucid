/**
 * Owns the integration modes: the lucid-owned headless sources (session
 * and per-turn) that drive harnesses through the normalizer's runners and
 * speak the chat protocol to the store host, and (M5.3) the interactive
 * adapter ladder. NOT responsible for durability or protocol enforcement -
 * the store hosts the reducer; these modules are sources.
 */

export { type ControllerAction, type ControllerActionKind, decideAction } from "./controller.js";
export { type HeadlessDeps, openHeadlessSession, openHeadlessTurns } from "./headless.js";
export { createHeadlessHost, type SourceChannel } from "./host.js";
export {
  A003_GATE_OPEN,
  type AnnounceAttach,
  attachCapabilities,
  chunkInjection,
  INJECTION_CAP,
  type LadderEnv,
  parseAnnounce,
  RUNGS,
  type Rung,
  type RungProfile,
  selectRung,
  type TailResult,
  tailTranscript,
} from "./interactive.js";
