/**
 * Headless adapters — thin façade over the deep `HeadlessHost` module.
 *
 * The turn lifecycle (currentTurnId pump, FIFO/expectation, receive +
 * credit forwarding, pump over Runner turns, detachOnce) now lives in
 * `src/modes/host.ts` behind a strategy table. This file preserves the
 * original import path (`src/modes/headless.js`) so `src/cli/runtime.ts`,
 * tests, and any external importers keep their seam without retargeting,
 * while the deep module is the single owner of the lifecycle. The
 * deletion test: this file should be deletable with only import-path
 * updates; all lifecycle bug fixes belong in `host.ts`.
 *
 * What it is NOT: it does not know the flock, the durable log, or the
 * presence lock — it drives a harness through its Runner.
 */

import { createHeadlessHost } from "./host.js";

export type { HeadlessDeps, SourceChannel } from "./host.js";
export { createHeadlessHost, HeadlessError } from "./host.js";

/** Mode 2: one persistent process serves many turns. Thin adapter over Host. */
export const openHeadlessSession = (
  deps: Parameters<typeof createHeadlessHost>[0] & { readonly sessionId: string },
): ReturnType<typeof createHeadlessHost> => createHeadlessHost(deps, "headless-session");

/** Mode 1: one process per turn. Thin adapter over Host. */
export const openHeadlessTurns = (
  deps: Parameters<typeof createHeadlessHost>[0] & { readonly resume?: string },
): ReturnType<typeof createHeadlessHost> => createHeadlessHost(deps, "headless-turn");
