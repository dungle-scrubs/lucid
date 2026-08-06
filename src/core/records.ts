import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ARTIFACT_EXTS } from "./inventory.ts";
import { sessionState } from "./log.ts";
import { canonicalArtifactPath, sessionPaths, type SessionPaths } from "./paths.ts";

/**
 * The one record-discovery owner (M1.10). Three sites each walked roots for
 * `log.ndjson` with their own prune list and their own log->artifact
 * resolution: the registry's `scanRoots` (pruning `node_modules`/etc. plus
 * non-`.lucid` dot-dirs), the sessions listing's unpruned `Bun.Glob`, and the
 * inventory script's `findLogs` (pruning a slightly different set). A record
 * found by one and missed by another was the drift; this module owns the walk
 * and the resolution so every consumer agrees.
 *
 * Only the two pure operations - which logs exist, and which artifact a log
 * belongs to - live here. Layout classification (`classifyLucidRecord`) and
 * the migration it serves stay in `inventory.ts`, and the per-session summary
 * the listing builds stays in `sessions.ts`.
 */

/**
 * Directories record discovery never descends. A glob over all of `~/dev`
 * spends nearly all of its time inside dependency and build trees, and the hub
 * re-scans while a shell is connected - so pruned subtrees are never ENTERED
 * (Bun.Glob has no exclude, and traversal is the whole cost).
 *
 * Dot-directories are pruned too, except `.lucid` (where canonical records
 * live): `.git`, `.cache` and friends cannot hold a project's records and
 * dominate the walk time. The ONE list, so a new heavy tree is pruned for
 * every consumer at once.
 */
const PRUNE = new Set(["node_modules", "dist", "build", "target", "vendor"]);

const isPrunedDir = (name: string): boolean =>
  PRUNE.has(name) || (name.startsWith(".") && name !== ".lucid");

/**
 * Recursively find every review record's `log.ndjson` under each root and
 * return the absolute, deduped log paths. A hand-rolled walk rather than a
 * glob so pruned subtrees are never entered (see `PRUNE`). Unreadable
 * directories are skipped rather than fatal - a sweep of `~/dev` must not die
 * on one locked folder.
 */
export const findRecords = async (roots: readonly string[]): Promise<readonly string[]> => {
  const found = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: skip rather than fail the scan
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isPrunedDir(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "log.ndjson") {
        found.add(join(dir, entry.name));
      }
    }
  };
  for (const root of roots) await walk(resolve(root));
  return [...found];
};

/**
 * Resolve a discovered `log.ndjson` to its record's `SessionPaths`, reading
 * the artifact basename from the log's `session_opened` event - so a `.md`
 * artifact is found by the name it was opened under, not assumed `.html`.
 * Falls back to probing the extension vocabulary (`ARTIFACT_EXTS`) when the log
 * is unreadable or predates the stamp, and finally to the stem-derived name.
 *
 * The resolution is relative to the record's parent dir, which is the
 * `.lucid/` dir for canonical/nested layouts and the artifact's own dir for
 * the sibling layout - the same resolution the registry and listing each did
 * inline.
 */
export const recordPathsFor = async (logPath: string): Promise<SessionPaths> => {
  const recordDir = dirname(logPath);
  const stem = basename(recordDir);
  const artifactDir = dirname(recordDir);
  // Read the artifact name off the log via the stem-derived session (its
  // logPath IS the discovered log for every layout the writer produces).
  let recorded: string | undefined;
  try {
    recorded =
      (await sessionState(sessionPaths(resolve(artifactDir, `${stem}.html`)))).artifact ||
      undefined;
  } catch {
    // Unreadable or absent log: nothing recorded to read.
  }
  // The recorded name is authoritative when present; otherwise probe the
  // extension vocabulary in order (`.html` first) rather than assuming - a
  // record whose log predates `session_opened` still deserves its real
  // artifact, which may be `.md`.
  const artifact =
    recorded ??
    (await firstExisting(
      artifactDir,
      ARTIFACT_EXTS.map((ext) => `${stem}${ext}`),
    )) ??
    `${stem}.html`;
  return sessionPaths(canonicalArtifactPath(resolve(artifactDir, artifact)));
};

/** The first name in `candidates` that exists under `dir`, or undefined. */
const firstExisting = async (
  dir: string,
  candidates: readonly string[],
): Promise<string | undefined> => {
  for (const name of candidates) {
    if (await fileExists(join(dir, name))) return name;
  }
  return undefined;
};

const fileExists = (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch(() => false);
