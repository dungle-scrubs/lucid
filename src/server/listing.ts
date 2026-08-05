/**
 * The hub's session listing (M5.4): stale-while-revalidate, snapshot assembly,
 * and the notify dedupe/re-entrancy queue.
 *
 * Extracted from daemon.ts so the listing's data flow is one module's concern.
 * The daemon provides the `compute` callback (which reads disk and knows which
 * sessions are hosted) and the `attention` callback (which reads session
 * state); this module owns the SWR wrapper, the dedupe hashes, and the
 * re-entrancy queue that prevents a broadcast storm.
 */
import type { SessionPaths } from "../core/paths.ts";
import { swr } from "../core/swr.ts";
import { DEFAULT_FRAME } from "../protocol/frames.ts";
import type { HubAttention } from "../protocol/hub.ts";
import type { HubFrame, HubListing } from "../protocol/frames.ts";
import type { HubSession } from "../protocol/hub.ts";

export interface ListingCaches {
  /** Resolve an artifact's project (cached). */
  resolveProject: (artifact: string) => Promise<{ project: string; worktree?: string }>;
  /** Read an artifact's <title> (cached against mtime). */
  readTitle: (artifact: string) => Promise<string | null>;
}

export interface ListingOptions {
  /** Compute the full listing. Receives the cache-backed project/title
   *  helpers so the caches live in this module, not the daemon. */
  readonly compute: (caches: ListingCaches) => Promise<HubSession[]>;
  /** The bundle stamp for snapshot dev-mode reload detection. */
  readonly bundleStamp: () => string;
  /** The attention snapshot for all known sessions. */
  readonly attention: () => Record<string, HubAttention>;
  /** Broadcast a frame to every connected shell window. */
  readonly broadcast: (frame: HubFrame) => void;
  /** How many windows are connected (0 = skip notify entirely). */
  readonly channelSize: () => number;
  /** Resolve an artifact's project grouping (core/project.ts). */
  readonly projectOf: (paths: SessionPaths) => Promise<{ project: string; worktree?: string }>;
  /** Parse a title from the first N bytes of an artifact file. */
  readonly parseTitle: (html: string) => string | null;
  /** stat for mtime checks. */
  readonly stat: (path: string) => Promise<{ mtimeMs: number }>;
  /** Read the head of an artifact file for title parsing. */
  readonly readHead: (path: string, bytes: number) => Promise<string>;
  readonly sessionPaths: (artifact: string) => SessionPaths;
}

export interface Listing {
  /** The cached listing (serves stale while revalidating). */
  cached: () => Promise<readonly HubSession[]>;
  /** Force a fresh compute (after a known change). */
  fresh: () => Promise<readonly HubSession[]>;
  /** Invalidate the cache so the next read re-computes. */
  invalidate: () => void;
  /** The listing + bundle stamp, in cached or after-change mode. */
  snapshot: (mode?: "cached" | "after-change") => Promise<HubListing>;
  /** Broadcast listing + attention if either changed (deduped, re-entrant). */
  notify: (mode?: "cached" | "after-change") => Promise<void>;
  /** Project and title cache helpers (M5.4: caches live behind the listing). */
  resolveProject: (artifact: string) => Promise<{ project: string; worktree?: string }>;
  readTitle: (artifact: string) => Promise<string | null>;
}

/** Create the listing module. The SWR wrapper, dedupe hashes,
 *  re-entrancy queue, and project/title caches all live here. */
export const createListing = (opts: ListingOptions): Listing => {
  const pollMs = 2000;

  // ---- project and title caches (M5.4) -------------------------------
  const projectCache = new Map<string, { project: string; worktree?: string }>();
  const resolveProject = async (
    artifact: string,
  ): Promise<{ project: string; worktree?: string }> => {
    const cached = projectCache.get(artifact);
    if (cached !== undefined) return cached;
    const { project, worktree } = await opts.projectOf(opts.sessionPaths(artifact));
    const resolved = { project, ...(worktree !== undefined ? { worktree } : {}) };
    projectCache.set(artifact, resolved);
    return resolved;
  };

  const titleCache = new Map<string, { readonly mtimeMs: number; readonly title: string | null }>();
  const readTitle = async (artifact: string): Promise<string | null> => {
    let mtimeMs: number;
    try {
      mtimeMs = (await opts.stat(artifact)).mtimeMs;
    } catch {
      return null;
    }
    const hit = titleCache.get(artifact);
    if (hit && hit.mtimeMs === mtimeMs) return hit.title;
    let title: string | null = null;
    try {
      title = opts.parseTitle(await opts.readHead(artifact, 8192));
    } catch {
      title = null;
    }
    titleCache.set(artifact, { mtimeMs, title });
    return title;
  };

  const caches: ListingCaches = { resolveProject, readTitle };
  const listing = swr(() => opts.compute(caches), { minAgeMs: pollMs });

  let lastSnapshot = "";
  let lastAttentionSnapshot = "";
  let notifying = false;
  let notifyAgain = false;
  let ticks = 0;
  const TICK_EVERY = Math.max(1, Math.round(10_000 / pollMs));

  const snapshot = async (mode: "cached" | "after-change" = "cached"): Promise<HubListing> => {
    const sessions = mode === "after-change" ? await listing.fresh() : await listing.cached();
    return { sessions, bundle: opts.bundleStamp() };
  };

  const invalidate = (): void => {
    listing.invalidate();
    // Reset the dedupe hashes so the next notify always broadcasts, even if
    // the listing data is byte-identical to the last frame. This replaces the
    // daemon's old `lastSnapshot = ""` reset.
    lastSnapshot = "";
    lastAttentionSnapshot = "";
  };

  const notify = async (mode: "cached" | "after-change" = "cached"): Promise<void> => {
    if (opts.channelSize() === 0) return;
    ticks += 1;
    if (ticks % TICK_EVERY === 0) opts.broadcast({ event: "tick", data: null });
    if (notifying) {
      if (mode === "after-change") notifyAgain = true;
      return;
    }
    notifying = true;
    try {
      // Listing and attention are deduped SEPARATELY: a `working` flip changes
      // only the attention snapshot, so the listing frame is not re-sent (R3).
      const snap = await snapshot(mode);
      const snapJson = JSON.stringify(snap);
      if (snapJson !== lastSnapshot) {
        lastSnapshot = snapJson;
        opts.broadcast({ event: DEFAULT_FRAME, data: snap });
      }
      const att = opts.attention();
      const attJson = JSON.stringify(att);
      if (attJson !== lastAttentionSnapshot) {
        lastAttentionSnapshot = attJson;
        opts.broadcast({ event: "attention", data: att });
      }
    } catch {
      // A listing that throws must not take the hub down.
    } finally {
      notifying = false;
    }
    if (notifyAgain) {
      notifyAgain = false;
      await notify("after-change");
    }
  };

  return {
    cached: () => listing.cached(),
    fresh: () => listing.fresh(),
    invalidate,
    snapshot,
    notify,
    resolveProject,
    readTitle,
  };
};
