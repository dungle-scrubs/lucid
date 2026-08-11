/**
 * Owns the integration modes: the lucid-owned headless sources (session
 * and per-turn) that drive harnesses through the normalizer's runners and
 * speak the chat protocol to the store host, and (M5.3) the interactive
 * adapter ladder. NOT responsible for durability or protocol enforcement -
 * the store hosts the reducer; these modules are sources.
 */
export { type HeadlessDeps, openHeadlessSession, openHeadlessTurns } from "./headless.js";
