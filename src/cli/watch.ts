/**
 * `lucid watch`: the read-only TUI view-model emitter (C2).
 *
 * Folds the log and emits the `src/tui/view.ts` ConversationView,
 * refreshing as the log grows. Before, it hardcoded
 * `status = "interactive-unattached"` and never consulted the liveness
 * module — so a live `headless-session`, a `headless-turn`, or an
 * `agent-gone` conversation looked identical on screen, and
 * `protocol/liveness:channelStatus` had zero CLI consumers. Fixing
 * watch's status required understanding the lease clock in a second
 * place, with no injectable seam for tests.
 *
 * Now one module (the liveness projection) owns the policy and this
 * file hosts it: it reads `state` from the same `viewConversation`
 * fold, injects `now` (and optionally `presence`), and derives the real
 * `ChannelStatus` via `channelStatus`. The deletion test passes:
 * deleting the liveness module would scatter lease-expiry arithmetic
 * across `watch` and `store:status()` — two readers, two clocks.
 *
 * What it is NOT: it is not the rich TUI app (that lives above this),
 * not a live source, and not a holder of the presence lock. It holds
 * NO append lock and dispatches nothing — a pure reader (M1.2).
 */

import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { channelStatus } from "../protocol/liveness.js";
import { viewConversation } from "../store/store.js";
import type { TuiView } from "../tui/view.js";
import { buildView } from "../tui/view.js";
import { conversations } from "./conversations.js";

export interface WatchOpts {
  readonly rootDir?: string;
  /** How often to poll when fs.watch is unavailable (ms). */
  readonly pollMs?: number;
  /** Called for each fresh view. The CLI's paint step lives here in
   * tests; the real `lucid watch` paints to the terminal. */
  readonly onView: (view: TuiView) => void;
  /** Abort signal to stop watching. */
  readonly signal?: AbortSignal;
  /** Injected clock — defaults to `Date.now`. Injected so tests can
   * assert lease-expiry transitions without wall-clock flakiness. */
  readonly now?: () => number;
  /** Injected presence probe — defaults to `() => undefined` (unknown,
   * which `channelStatus` treats as `agent-gone` on a dead channel,
   * mirroring `store:status()`'s `presence() === true` check). */
  readonly presence?: () => boolean | undefined;
  /** Seam for tests — defaults to the real `viewConversation`. */
  readonly viewConversationFn?: typeof viewConversation;
}

/** Emit the current view and then refresh as the log grows. Resolves
 * when `signal` aborts, or never (long-lived) when no signal is given.
 * Holds no lock and dispatches nothing. */
export const watchConversation = async (conversationId: string, opts: WatchOpts): Promise<void> => {
  const dir = conversations(opts.rootDir).dirFor(conversationId);
  const pollMs = opts.pollMs ?? 500;
  const viewFn = opts.viewConversationFn ?? viewConversation;
  const nowFn = opts.now ?? (() => Date.now());
  const presenceFn = opts.presence ?? (() => undefined);

  const emit = (): void => {
    try {
      const { transcript, state } = viewFn(dir);
      // Derive the real status from the folded state + injected clock +
      // presence, via the single liveness module (C2). Mirrors
      // `store:status()`'s `presence() === true` mapping so unknown
      // presence on a dead channel shows `agent-gone`, not a stale
      // `interactive-unattached`.
      const status = channelStatus(state, nowFn(), {
        processAlive: presenceFn() === true,
      });
      const view = buildView({ transcript, status, rung: "watch", draft: "" });
      opts.onView(view);
    } catch (e) {
      // A missing record or corrupt log is surfaced as a view with an
      // error line, not a thrown watch failure - the watcher is a
      // viewer, not a writer.
      const msg = e instanceof Error ? e.message : String(e);
      opts.onView({
        lines: [{ kind: "agent", text: `watch error: ${msg}` }],
        status: "error",
        rung: "watch",
        inputBox: "",
      });
    }
  };

  emit();

  if (opts.signal?.aborted) return;

  return new Promise<void>((resolve) => {
    const abort = (): void => {
      watcher?.close();
      clearInterval(poll);
      resolve();
    };
    if (opts.signal) opts.signal.addEventListener("abort", abort, { once: true });

    let watcher: ReturnType<typeof fsWatch> | undefined;
    try {
      watcher = fsWatch(join(dir, "log.ndjson"), emit);
      watcher.on("error", () => {});
    } catch {
      // Record dir may not exist yet; poll will pick it up.
    }
    const poll = setInterval(emit, pollMs);
    // Also poll on an interval as a fallback for filesystems where
    // fs.watch is unreliable (network FS is out of scope, D-004, but
    // polling keeps the viewer live even there).
  });
};
