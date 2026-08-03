import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { LogError } from "../errors.ts";
import { hasId, maxSeq, type EventInput, type LogEvent } from "./events.ts";
import { foldLog, type FoldedState, type SessionStatus } from "./fold.ts";
import { withAppendLock } from "./lock.ts";
import type { SessionPaths } from "./paths.ts";

export interface ReadResult {
  readonly events: readonly LogEvent[];
  /** True if the file ended with an incomplete (non-newline-terminated) line. */
  readonly tornTail: boolean;
}

/**
 * Parse NDJSON log bytes, tolerating a torn trailing line (crash mid-append)
 * per D-030. A parse failure on a *committed* (newline-terminated) line is a
 * `LogError`; an incomplete final line is silently ignored.
 */
const parseLog = (content: string): ReadResult => {
  if (content.length === 0) return { events: [], tornTail: false };

  const endsWithNewline = content.endsWith("\n");
  const parts = content.split("\n");
  // Drop the trailing element: an empty string if newline-terminated, otherwise
  // the torn final line.
  const tornTailContent = parts.pop();
  const tornTail = !endsWithNewline && (tornTailContent ?? "").length > 0;

  const events: LogEvent[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line === undefined || line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      throw new LogError({
        message: `corrupt committed log line ${i + 1}`,
        detail: { line: i + 1, content: line.slice(0, 200) },
      });
    }
  }
  return { events, tornTail };
};

/**
 * Read and parse the event log. A missing file is an empty log.
 *
 * @internal The RAW seam, for the few readers that need events rather than
 * state (a seq scan, an ownership sweep). Folded state comes from
 * `sessionState`, which caches; this always re-reads.
 */
export const readEvents = async (logPath: string): Promise<ReadResult> => {
  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], tornTail: false };
    }
    throw new LogError({ message: `cannot read log: ${(err as Error).message}` });
  }
  return parseLog(content);
};

const readEventsSync = (logPath: string): ReadResult => {
  let content: string;
  try {
    content = readFileSync(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], tornTail: false };
    }
    throw new LogError({ message: `cannot read log: ${(err as Error).message}` });
  }
  return parseLog(content);
};

// ---- the folded-state seam ------------------------------------------------

/** What the fold cache reads off the log file to decide freshness. */
interface StatKey {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface SessionStateCache {
  /** Folded state for a log path, folding only when the file changed. */
  state(logPath: string): FoldedState;
  /** Same, off an async read on a miss. */
  stateAsync(logPath: string): Promise<FoldedState>;
  /** Drop a log's entry: this process just changed the file in a way the stat
   *  pair may not show. */
  forget(logPath: string): void;
  /** Inspectable counters for the hub debug surface (observability). */
  stats(): { readonly hits: number; readonly misses: number; readonly entries: number };
}

const defaultStat = (logPath: string): StatKey => {
  const s = statSync(logPath);
  return { mtimeMs: s.mtimeMs, size: s.size };
};

const defaultStatAsync = async (logPath: string): Promise<StatKey> => {
  const s = await stat(logPath);
  return { mtimeMs: s.mtimeMs, size: s.size };
};

/**
 * How many folded logs the cache keeps.
 *
 * A `FoldedState` retains the log's whole text - every message, every
 * annotation with its anchor snippets, every version row - so this bound is
 * what keeps a long-lived hub's memory flat. The hub folds every session under
 * its scan roots on each poll, not just the tabs it has mounted, so an
 * unbounded map would grow with the total text of every log the machine has
 * ever held and never shrink. Eviction costs one re-fold, and the
 * least-recently-read entry is the one least likely to be asked for next.
 */
const MAX_CACHE_ENTRIES = 64;

/**
 * A per-path fold cache keyed on the log's `mtime + size`. An untouched log is
 * one `stat` and a map lookup, no read and no fold - which is what keeps a
 * waiting agent's heartbeat (`core/wait.ts`) and the hub's listing poll off a
 * full re-fold of every log every second.
 *
 * The `+ size` half is load-bearing: an append that grows the file without
 * bumping mtime (coarse mtime granularity) would otherwise serve stale state.
 * Size alone is not enough either, and neither is the pair: `appendEventsIf`
 * truncates a torn tail before it writes, so a log CAN shrink, and a truncate
 * plus an append of the same byte length inside one mtime tick lands back on
 * the key it started from. So an in-process mutation forgets its own entry
 * (`forget`); the stat pair is the cross-process backstop, not the whole story.
 *
 * The stat and read functions are injectable so both edges - and eviction - are
 * testable without depending on filesystem mtime granularity.
 *
 * @internal Exported for the cache's own test. Production reads go through
 * `sessionState` / `sessionStateSync`, which share one process-wide instance.
 */
export const createSessionStateCache = (deps?: {
  statOf?: (logPath: string) => StatKey;
  read?: (logPath: string) => readonly LogEvent[];
  maxEntries?: number;
}): SessionStateCache => {
  const statOf = deps?.statOf ?? defaultStat;
  const statOfAsync: (logPath: string) => Promise<StatKey> = deps?.statOf
    ? async (p: string) => statOf(p)
    : defaultStatAsync;
  const readSync = deps?.read ?? ((p: string) => readEventsSync(p).events);
  const readAsync = deps?.read
    ? async (p: string) => deps.read?.(p) ?? []
    : async (p: string) => (await readEvents(p)).events;
  const maxEntries = deps?.maxEntries ?? MAX_CACHE_ENTRIES;
  const cache = new Map<string, { key: string; value: FoldedState }>();
  let hits = 0;
  let misses = 0;

  const keyFrom = ({ mtimeMs, size }: StatKey): string => `${mtimeMs}:${size}`;

  /** A log that cannot be stat'd (not created yet, or gone) has no key: it
   *  folds uncached, off a read that answers the empty log, and drops whatever
   *  the path held - a deleted session must not keep its last full fold alive
   *  for the life of the process. */
  const unkeyed = (logPath: string): undefined => {
    cache.delete(logPath);
    return undefined;
  };

  const keyOf = (logPath: string): string | undefined => {
    try {
      return keyFrom(statOf(logPath));
    } catch {
      return unkeyed(logPath);
    }
  };

  /** The async seam's key, off an async stat: every hub handler reads through
   *  `sessionState`, and a blocking `statSync` there puts a syscall on the
   *  event loop for each one. */
  const keyOfAsync = async (logPath: string): Promise<string | undefined> => {
    try {
      return keyFrom(await statOfAsync(logPath));
    } catch {
      return unkeyed(logPath);
    }
  };

  const fresh = (logPath: string, key: string | undefined): FoldedState | undefined => {
    if (key === undefined) return undefined;
    const hit = cache.get(logPath);
    if (hit?.key !== key) return undefined;
    hits++;
    // Re-inserted, because a `Map` iterates in insertion order: this is what
    // makes the first key the least recently read one.
    cache.delete(logPath);
    cache.set(logPath, hit);
    return hit.value;
  };

  /** Stored against the key read BEFORE the read: a write that landed in the
   *  gap leaves a value newer than its key claims, so the next stat misses and
   *  re-folds rather than serving a value it can never invalidate. */
  const store = (logPath: string, key: string | undefined, value: FoldedState): FoldedState => {
    misses++;
    if (key === undefined) return value;
    cache.delete(logPath);
    cache.set(logPath, { key, value });
    for (const oldest of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(oldest);
    }
    return value;
  };

  return {
    state(logPath) {
      const key = keyOf(logPath);
      return fresh(logPath, key) ?? store(logPath, key, foldLog(readSync(logPath)));
    },
    async stateAsync(logPath) {
      const key = await keyOfAsync(logPath);
      const hit = fresh(logPath, key);
      if (hit) return hit;
      return store(logPath, key, foldLog(await readAsync(logPath)));
    },
    forget(logPath) {
      cache.delete(logPath);
    },
    stats() {
      return { hits, misses, entries: cache.size };
    },
  };
};

const stateCache = createSessionStateCache();

/**
 * The session's current state: the one read seam over its event log.
 *
 * Everything a caller can want to know about a session - its status, version,
 * annotations, questions, the working window - is the fold of its log, so
 * reading, tolerating a torn tail, folding and caching belong together rather
 * than being re-spelled at every callsite.
 */
export const sessionState = async (paths: SessionPaths): Promise<FoldedState> =>
  stateCache.stateAsync(paths.logPath);

/** `sessionState` for the callers that cannot await (the hub's listing poll). */
export const sessionStateSync = (paths: SessionPaths): FoldedState =>
  stateCache.state(paths.logPath);

/** The shared fold cache's hit/miss/entries, for the hub debug surface. */
export const sessionStateCacheStats = (): ReturnType<SessionStateCache["stats"]> =>
  stateCache.stats();

/** Set of all client/CLI-minted ids present in the log (for dedupe; D-057). */
export const collectIds = (events: readonly LogEvent[]): Set<string> => {
  const ids = new Set<string>();
  for (const e of events) if (hasId(e)) ids.add(e.id);
  return ids;
};

const inputId = (input: EventInput): string | undefined =>
  "id" in input ? (input as { id: string }).id : undefined;

/** Synchronous, fsync'd append of a payload string to the log fd. */
const appendDurable = (logPath: string, payload: string): void => {
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Truncate a torn (non-newline-terminated) trailing line in-place, leaving the
 * file ending at the last newline. Called inside the append lock before writing
 * so that an append following a crash-mid-append does not concatenate onto the
 * partial line and corrupt the log (D-030).
 */
const truncateTornTail = (logPath: string): void => {
  let data: Buffer;
  try {
    data = readFileSync(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (data.length === 0 || data[data.length - 1] === 0x0a /* \n */) return;
  const lastNewline = data.lastIndexOf(0x0a);
  const cut = lastNewline === -1 ? 0 : lastNewline + 1;
  truncateSync(logPath, cut);
};

/**
 * Append events under the exclusive log lock (D-049). Re-reads inside the lock
 * to assign globally-monotonic `seq` (D-050) and to dedupe identified events
 * against the ids already in the log (D-057). A torn trailing line from a prior
 * crash-mid-append is truncated before writing so the new append never
 * concatenates onto a partial line (D-030). Returns the resulting events in
 * input order - newly appended events with their assigned `seq`/`at`, and for a
 * deduped input the pre-existing event already in the log.
 */
export const appendEvents = async (
  paths: SessionPaths,
  inputs: readonly EventInput[],
): Promise<readonly LogEvent[]> => appendEventsIf(paths, () => true, inputs);

/** Convenience single-event append. */
export const appendEvent = async (paths: SessionPaths, input: EventInput): Promise<LogEvent> => {
  const [ev] = await appendEvents(paths, [input]);
  if (ev === undefined) {
    throw new LogError({ message: "append produced no event" });
  }
  return ev;
};

/**
 * Atomically check-then-append under the exclusive log lock (D-049). Runs
 * `guard` (re-reading the log inside the lock) and only commits `inputs` if the
 * guard returns true. This closes the TOCTOU where a status check outside the
 * lock could let an event land in a just-closed segment. Returns the appended
 * events (empty if the guard rejected) in input order, with dedupe applied.
 */
export const appendEventsIf = async (
  paths: SessionPaths,
  guard: (events: readonly LogEvent[]) => boolean | Promise<boolean>,
  inputs: readonly EventInput[],
): Promise<readonly LogEvent[]> => {
  if (inputs.length === 0) return [];
  const logPath = paths.logPath;
  // The lock is machine-local (plan 02, D-002), so it lives in the record's
  // `run/` dir, not beside the committed log: `<record>/run/log.ndjson.lock`.
  // `run/` is created by `ensureSessionDirs` and, defensively, by
  // `withAppendLock` itself before it opens the lock.
  const lockTarget = resolve(paths.runDir, "log.ndjson");
  return withAppendLock(lockTarget, async () => {
    // Uncached, always: the guard and the seq assignment are the whole point of
    // being inside the lock, and a folded value from before it proves nothing.
    const { tornTail, events } = await readEvents(logPath);
    // Both mutations below forget the cached fold rather than trusting the stat
    // pair to move: the truncate SHRINKS the file, so a truncate-then-append of
    // the same byte length inside one mtime tick would otherwise leave the
    // pre-append fold looking fresh forever.
    if (tornTail) {
      truncateTornTail(logPath);
      stateCache.forget(logPath);
    }
    if (!(await guard(events))) return [];
    const existingIds = collectIds(events);
    let seq = maxSeq(events);
    const at = new Date().toISOString();
    const toWrite: LogEvent[] = [];
    const result: LogEvent[] = [];
    for (const input of inputs) {
      const id = inputId(input);
      if (id !== undefined && existingIds.has(id)) {
        const existing = events.find((e) => hasId(e) && e.id === id);
        if (existing) result.push(existing);
        continue;
      }
      seq += 1;
      const ev = { ...input, seq, at } as LogEvent;
      toWrite.push(ev);
      result.push(ev);
      if (id !== undefined) existingIds.add(id);
    }
    if (toWrite.length > 0) {
      const payload = `${toWrite.map((e) => JSON.stringify(e)).join("\n")}\n`;
      appendDurable(logPath, payload);
      stateCache.forget(logPath);
    }
    return result;
  });
};

/**
 * Append only while the session is still in `status`, re-checked inside the
 * lock. The status a caller read outside the lock is the one thing every
 * lifecycle-sensitive append has to re-establish, so it is spelled once here
 * rather than as a fold in each caller's guard.
 */
export const appendIfStatus = async (
  paths: SessionPaths,
  status: SessionStatus,
  inputs: readonly EventInput[],
): Promise<readonly LogEvent[]> =>
  appendEventsIf(paths, (events) => foldLog(events).status === status, inputs);
