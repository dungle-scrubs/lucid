/**
 * `lucid watch`: the read-only TUI view-model emitter.
 *
 * Folds the log and emits the `src/tui/view.ts` view-model, refreshing as
 * the log grows. It holds NO lock and dispatches nothing - it is a pure
 * reader (M1.2: "a pure read-only viewer may fold lock-free"). It reuses
 * the existing `src/tui/` view-model shape (no duplication, Open Question 2).
 *
 * What it is NOT: it is not the rich TUI app (that lives above this),
 * not a live source, and not a holder of the presence lock.
 */

import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { ChannelStatus } from "../protocol/index.js";
import { viewConversation } from "../store/store.js";
import type { TuiView } from "../tui/view.js";
import { buildView } from "../tui/view.js";

export interface WatchOpts {
  readonly rootDir?: string;
  /** How often to poll when fs.watch is unavailable (ms). */
  readonly pollMs?: number;
  /** Called for each fresh view. The CLI's paint step lives here in
   * tests; the real `lucid watch` paints to the terminal. */
  readonly onView: (view: TuiView) => void;
  /** Abort signal to stop watching. */
  readonly signal?: AbortSignal;
}

const defaultRoot = (): string =>
  process.env.LUCID_ROOT ?? join(process.env.HOME ?? "/tmp", ".lucid", "records");

/** Emit the current view and then refresh as the log grows. Resolves
 * when `signal` aborts, or never (long-lived) when no signal is given.
 * Holds no lock and dispatches nothing. */
export const watchConversation = async (conversationId: string, opts: WatchOpts): Promise<void> => {
  const rootDir = opts.rootDir ?? defaultRoot();
  const dir = join(rootDir, conversationId);
  const pollMs = opts.pollMs ?? 500;

  const emit = (): void => {
    try {
      const { transcript } = viewConversation(dir);
      // Watch has no live source, so status is derived from the folded
      // state with an uncorroborated presence sample (it never claims
      // attached - that is the presence lock's job).
      const status: ChannelStatus = "interactive-unattached";
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
