/**
 * The harness seam: everything lucid knows about driving a coding-agent CLI.
 *
 * One rule holds this module together - lucid speaks to `hcn`, never to a
 * harness and never to the normalizer's internals. Above this seam nothing
 * knows what a descriptor is or how claude frames a turn.
 */
export {
  decodeHarnessLine,
  type HarnessEvent,
  type HarnessFailure,
} from "./events.js";
export { createHcnRunner } from "./hcn-runner.js";
export {
  assertHcnVersion,
  nodeHarnessDeps,
  nodeSpawnHcn,
  resolveHcnBin,
} from "./node-deps.js";
export type { HarnessDeps, HcnProcess, SpawnHcn } from "./process.js";
export { AsyncQueue } from "./queue.js";
export {
  type CapabilityResult,
  type ContextCount,
  type ContextCountOptions,
  type Disposition,
  type HarnessFacts,
  type HarnessMode,
  type HarnessName,
  HarnessRefusal,
  type HarnessRunner,
  HarnessSpawnError,
  type HarnessTurn,
  HarnessVersionError,
  type OpenSessionOptions,
  type SendResult,
  type SessionClosed,
  type SessionHandle,
  type StreamTurnOptions,
} from "./runner.js";
export { belowFloor, compareVersions, HCN_MIN_VERSION } from "./version.js";
