/**
 * `lucid run` — thin adapter over the deep `HostRuntime`.
 *
 * The lifecycle (record ensure, host open, presence acquire, source
 * attach, abort, release-once) lives in `src/cli/runtime.ts`. This file
 * is the CLI entry that maps `RunOpts` to the runtime and preserves the
 * original `Promise<{conversationId, dir}>` shape for `src/cli/main.ts`.
 * When the controller gates the run as await-reattach (D-021), the
 * adapter surfaces the await without spawning a harness.
 *
 * What it is NOT: it does not own the flock, the fold, or the lease.
 */

import { type AwaitToken, type RuntimeDeps, runHeadless } from "./runtime.js";

export type RunOpts = RuntimeDeps;

export type RunResult = { conversationId: string; dir: string; awaitToken?: AwaitToken };

export const runConversation = async (opts: RunOpts = {}): Promise<RunResult> => runHeadless(opts);
