/**
 * `lucid watch`: the read-only TUI view-model emitter (C2 + 01 snapshot).
 *
 * Folds the log and emits the `src/tui/view.ts` ConversationView,
 * refreshing as the log grows. Before (C2), it hardcoded
 * `status = "interactive-unattached"` and never consulted the liveness
 * module. C2 made it host the liveness projection via
 * `viewConversation` + `channelStatus`. 01 deepens the read path: the
 * derivation now lives in `store:viewSnapshot` (fold once → status
 * from same state + injected clock/presence), so watch is one call,
 * not two. Deleting the snapshot helper would scatter fold+status
 * re-derivation across every reader again.
 *
 * What it is NOT: it is not the rich TUI app (that lives above this),
 * not a live source, and not a holder of the presence lock. It holds
 * NO append lock and dispatches nothing — a pure reader (M1.2).
 */

import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { channelStatus } from "../protocol/liveness.js";
// biome-ignore lint/style/useImportType: viewConversation used as typeof in WatchOpts — needed as value for typeof
import { type ViewSnapshot, viewConversation, viewSnapshot } from "../store/store.js";
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
  /** Seam for tests — defaults to the real `viewConversation`. @deprecated prefer viewSnapshotFn */
  readonly viewConversationFn?: typeof viewConversation;
  /** Preferred seam: atomic snapshot (state+transcript+status) in one
   * derivation (01). When provided, `viewConversationFn` is ignored. */
  readonly viewSnapshotFn?: (dir: string) => ViewSnapshot;
}

/** Emit the current view and then refresh as the log grows. Resolves
 * when `signal` aborts, or never (long-lived) when no signal is given.
 * Holds no lock and dispatches nothing. */
export const watchConversation = async (conversationId: string, opts: WatchOpts): Promise<void> => {
  const dir = conversations(opts.rootDir).dirFor(conversationId);
  const pollMs = opts.pollMs ?? 500;
  const nowFn = opts.now ?? (() => Date.now());
  const presenceFn = opts.presence ?? (() => undefined);

  const emit = (): void => {
    try {
      let transcript: ViewSnapshot["transcript"];
      let status: ViewSnapshot["status"];
      if (opts.viewSnapshotFn) {
        const snap = opts.viewSnapshotFn(dir);
        transcript = snap.transcript;
        status = snap.status;
      } else if (opts.viewConversationFn) {
        const viewFn = opts.viewConversationFn;
        const { transcript: tr, state } = viewFn(dir);
        transcript = tr;
        // Derive status via the single liveness module (C2). Mirrors
        // store:snapshot()'s presence() === true mapping.
        status = channelStatus(state, nowFn(), {
          processAlive: presenceFn() === true,
        });
      } else {
        // The ONE derivation for the watch read path (01): fold once,
        // derive status from that same state + injected clock/presence.
        const snap = viewSnapshot(dir, { now: nowFn, presence: presenceFn });
        transcript = snap.transcript;
        status = snap.status;
      }
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
