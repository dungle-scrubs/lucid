/**
 * Artifact change detection, end to end (plan 05, M3.2 / DF-1): the debounced
 * `fs.watch`, the stat-gated 1s poll, and the commit queue behind one module.
 *
 * Extracted from session-host.ts. Two invariants live here and must survive any
 * refactor:
 *
 * 1. **Commit coalescing.** A change that arrives while a commit is mid-flight
 *    does not RETURN (that lost the newer bytes until the next unrelated event:
 *    the in-flight commit recorded what it already read, the poll advanced its
 *    stat baseline, and a `commitNow` caller got a resolved promise for a commit
 *    that never ran). It queues exactly one rerun instead, and a signal during
 *    the rerun produces another.
 * 2. **Teardown after an in-flight commit.** `stop()` during a commit lets the
 *    commit complete and still records the version to the log; late callbacks
 *    are tolerated. A `stopped` guard INSIDE `commitNow` would silently lose a
 *    version (D-011).
 *
 * `commitNow` stays awaitable so the rename route can wait on a real commit. The
 * presence sweep is NOT here: it is broadcast presence, not change detection,
 * and stays with the host.
 */
import { statSync, watch } from "node:fs";
import { basename } from "node:path";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import type { LogEvent } from "../core/events.ts";
import type { Warning } from "../errors.ts";
import type { SessionPaths } from "../core/paths.ts";
import { commitWatchedChange } from "../core/session.ts";

export interface ArtifactWatchOptions {
  /** Watcher debounce (ms). Defaults to 150. */
  readonly debounceMs?: number;
  /** Receives the actually-appended event (real seq/timestamp), not a synthetic
   *  stand-in, so the SSE stream stays consistent with the log. */
  readonly onCommitted?: (event: LogEvent) => void;
  /** Receives a typed warning when a commit did not land. */
  readonly onWarning?: (warning: Warning) => void;
  /** The commit implementation. Defaults to `commitWatchedChange` (production);
   *  tests inject a controllable one to exercise coalescing and teardown
   *  timing without racing real disk I/O. */
  readonly commit?: (paths: SessionPaths) => Promise<{ committed?: LogEvent; warning?: Warning }>;
}

export interface ArtifactWatch {
  /** Awaitable commit of any pending artifact change. Re-entrant: a signal
   *  during an in-flight commit coalesces into one rerun after it completes,
   *  never a dropped or doubled commit. */
  readonly commitNow: () => Promise<void>;
  /** Stop the watcher, the stat-gated poll, and any pending debounce. Lets an
   *  in-flight commit complete (D-011). */
  readonly stop: () => void;
}

const DEFAULT_DEBOUNCE_MS = 150;

/** A cheap fingerprint (size + mtimeMs) the poll gates on, so a quiet session
 *  does not re-read + hash the artifact every second. */
const statFingerprint = (absPath: string): string | null => {
  try {
    const s = statSync(absPath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};

export const createArtifactWatch = (
  paths: SessionPaths,
  options: ArtifactWatchOptions = {},
): ArtifactWatch => {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const commit = options.commit ?? commitWatchedChange;
  const artifactBase = basename(paths.artifactPath);

  let committing = false;
  /** A change arrived while a commit was mid-flight. Silently RETURNING there
   *  lost the newer bytes until the next unrelated event. Queue one rerun. */
  let commitQueued = false;
  const commitNow = async (): Promise<void> => {
    if (committing) {
      commitQueued = true;
      return;
    }
    committing = true;
    try {
      do {
        commitQueued = false;
        try {
          const result = await commit(paths);
          if (result.committed) {
            options.onCommitted?.(result.committed);
          } else if (result.warning) {
            options.onWarning?.(result.warning);
          }
        } catch {
          // transient; the poll (or the queued rerun) retries
        }
      } while (commitQueued);
    } finally {
      committing = false;
    }
  };

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onChange = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void commitNow(), debounceMs);
  };

  // fs.watch is not guaranteed (Node documents this) and is unreliable through
  // a symlinked path or across atomic-rename saves, so a 1s hash poll backs it.
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(paths.artifactDir, (_event, filename) => {
      if (!filename || filename === artifactBase) onChange();
    });
  } catch {
    watcher = undefined;
  }

  let lastStat = statFingerprint(paths.artifactPath);
  const pollTimer = setInterval(() => {
    const next = statFingerprint(paths.artifactPath);
    if (next !== null && next !== lastStat) {
      lastStat = next;
      void commitNow();
    } else if (next !== null) {
      // unchanged; keep the baseline current
      lastStat = next;
    }
  }, 1000);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (watcher) watcher.close();
    if (debounce) clearTimeout(debounce);
    clearInterval(pollTimer);
  };

  return { commitNow, stop };
};
