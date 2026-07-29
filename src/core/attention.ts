/**
 * The attention fold (plan 03, M1.1).
 *
 * The grouped tab strip needs, per open artifact, four signals and nothing
 * else: how many questions are open, whether the agent is mid-turn, whether the
 * review is approved, and the log's high-water seq (so a consumer can tell
 * "new since I last looked"). `attentionOf` derives exactly those from the
 * event log - a projection over the tested `foldLog`, so it can never disagree
 * with the fold the rest of the app trusts.
 *
 * Because the strip polls every open tab, folding each log every poll is the
 * cost this milestone exists to avoid. `createAttentionCache` keys the folded
 * result on the log file's `mtime + size`: an untouched log is one `stat` and a
 * map lookup, no fold. The `+ size` half is load-bearing - an append that grows
 * the file without bumping mtime (coarse mtime granularity, in-place rewrites)
 * would otherwise serve stale attention. Hit/miss counts are inspectable for
 * the hub's debug surface (observability).
 */

import { readFileSync, statSync } from "node:fs";
import type { LogEvent } from "./events.ts";
import { foldLog } from "./fold.ts";

export interface Attention {
  /** Questions the human has not answered or skipped - the top precedence. */
  readonly openQuestions: number;
  /** The agent-work window is open (an ack with no agent output after it). */
  readonly working: boolean;
  /** The review has been approved. */
  readonly resolved: boolean;
  /** The log's high-water seq: the floor a consumer compares "last viewed" to. */
  readonly lastEventSeq: number;
}

/** Reduce an event log to the four attention signals. Pure. */
export const attentionOf = (events: readonly LogEvent[]): Attention => {
  const s = foldLog(events);
  return {
    openQuestions: s.questions.filter((q) => !q.answered && !q.skipped).length,
    working: s.agentWorking != null,
    resolved: s.reviewResolved,
    lastEventSeq: s.highSeq,
  };
};

/** What the cache reads off the log file to decide freshness. */
interface StatKey {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface AttentionCache {
  /** The current attention for a log path, folding only when it changed. */
  get(logPath: string): Attention;
  /** Inspectable counters for the hub debug surface (observability). */
  stats(): { readonly hits: number; readonly misses: number; readonly entries: number };
}

const defaultStat = (logPath: string): StatKey => {
  const s = statSync(logPath);
  return { mtimeMs: s.mtimeMs, size: s.size };
};

const defaultReadEvents = (logPath: string): LogEvent[] => {
  const text = readFileSync(logPath, "utf8");
  const events: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // Tolerate a torn trailing line (crash mid-append), exactly as readEvents
    // does: a half-written last line is skipped, not fatal.
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      /* torn tail */
    }
  }
  return events;
};

/**
 * A per-path attention cache keyed on the log's `mtime + size`. The stat and
 * read functions are injectable so the append-in-place edge (size grows, mtime
 * frozen) is testable without depending on filesystem mtime granularity.
 */
export const createAttentionCache = (deps?: {
  statOf?: (logPath: string) => StatKey;
  readEvents?: (logPath: string) => readonly LogEvent[];
}): AttentionCache => {
  const stat = deps?.statOf ?? defaultStat;
  const read = deps?.readEvents ?? defaultReadEvents;
  const cache = new Map<string, { key: string; value: Attention }>();
  let hits = 0;
  let misses = 0;

  return {
    get(logPath) {
      const { mtimeMs, size } = stat(logPath);
      const key = `${mtimeMs}:${size}`;
      const hit = cache.get(logPath);
      if (hit && hit.key === key) {
        hits++;
        return hit.value;
      }
      misses++;
      const value = attentionOf(read(logPath));
      cache.set(logPath, { key, value });
      return value;
    },
    stats() {
      return { hits, misses, entries: cache.size };
    },
  };
};
