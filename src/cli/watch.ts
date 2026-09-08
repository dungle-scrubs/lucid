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
 * RFC-04 step 4: the watch-and-poll loop no longer lives here. The
 * viewer is now an adapter over the shared tailer
 * (`store:followRecord` + `tailer.peek()`), so a live host and the
 * viewer run one mechanism, not two. The viewer only paints, so it
 * reads the lock-free peek; it never acts on what it reads, and a torn
 * tail the peek tolerates shows as a slightly-stale view until the
 * next trigger — correct for a viewer, forbidden for a dispatcher
 * (which is why the tailer keeps `read()` separate).
 *
 * What it is NOT: it is not the rich TUI app (that lives above this),
 * not a live source, and not a holder of the presence lock. It holds
 * NO append lock and dispatches nothing — a pure reader (M1.2).
 */

import { channelStatus } from "../protocol/liveness.js";
// biome-ignore lint/style/useImportType: viewConversation used as typeof in WatchOpts — needed as value for typeof
import { type ViewSnapshot, viewConversation } from "../store/conversation-host.js";
import { followRecord, type RecordTailer } from "../store/tailer.js";
import type { TuiView } from "../tui/view.js";
import { buildView } from "../tui/view.js";
import { type Conversations, conversations } from "./record-addressing.js";

export interface WatchOpts {
  readonly rootDir?: string;
  /** Injected addressing seam — CliHost provides the single `effectiveRoot`-bound factory. */
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
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
  const factory = opts.conversationsFactory ?? conversations;
  const dir = factory(opts.rootDir).dirFor(conversationId);
  const nowFn = opts.now ?? (() => Date.now());
  const presenceFn = opts.presence ?? (() => undefined);

  const emit = (tailer: RecordTailer): void => {
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
        // The ONE derivation for the watch read path (01): the shared
        // tailer's lock-free peek — fold once, derive status from that
        // same state + injected clock/presence.
        const snap = tailer.peek();
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

  return followRecord({
    dir,
    pollMs: opts.pollMs,
    signal: opts.signal,
    tailerDeps: { now: nowFn, presence: presenceFn },
    onTrigger: emit,
  });
};
