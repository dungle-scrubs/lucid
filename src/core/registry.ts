import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { writeJsonFile } from "./atomic-json.ts";
import { sessionState } from "./log.ts";
import { canonicalArtifactPath, sessionPaths } from "./paths.ts";
import { agentScratchpadRoots } from "./scratchpad.ts";

/**
 * The global pointer registry (Model B, Phase 0). A session is identified by the
 * canonical artifact path; the registry holds only POINTERS + `lastSeen`, never
 * session data. Session state stays co-located under `<project>/.lucid/<name>/`
 * (see paths.ts); this file lives centrally at `<home>/.lucid/registry.json`.
 *
 * The registry path is injectable for testing: every exported function takes an
 * optional `registryPath`, and `LUCID_REGISTRY` overrides the default. Tests
 * must never touch the real `~/.lucid`.
 */
export interface RegistryEntry {
  /** Canonical absolute artifact path = the session id. */
  readonly artifact: string;
  /** Artifact basename (display label). */
  readonly name: string;
  /** ISO timestamp of the last time this session was seen. */
  readonly lastSeen: string;
}

/** Resolve the registry file path: explicit override, then env, then default. */
export const registryFilePath = (registryPath?: string): string => {
  if (registryPath) return registryPath;
  if (process.env.LUCID_REGISTRY) return process.env.LUCID_REGISTRY;
  return resolve(homedir(), ".lucid", "registry.json");
};

/**
 * Default discovery roots: `~/dev` for project checkouts, plus this user's
 * agent scratchpads - which is where nearly every artifact actually lives. A
 * project-only default made a machine with a hundred past reviews report none.
 */
export const defaultRoots = (): string[] => [resolve(homedir(), "dev"), ...agentScratchpadRoots()];

/** Resolve the added-roots file path: explicit override, then env, then default. */
export const rootsFilePath = (rootsPath?: string): string => {
  if (rootsPath) return rootsPath;
  if (process.env.LUCID_ROOTS) return process.env.LUCID_ROOTS;
  return resolve(homedir(), ".lucid", "roots.json");
};

/**
 * Folders a human added by hand, scanned ON TOP of `defaultRoots`. The default
 * root is a guess about where projects live; this file is the human's answer
 * when the guess is wrong - an artifact under a scratchpad, a checkout outside
 * `~/dev`. Persisted, because a folder named once must survive a hub restart.
 */
export const readRoots = async (rootsPath?: string): Promise<string[]> => {
  try {
    const parsed = JSON.parse(await readFile(rootsFilePath(rootsPath), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Absolute paths only: a relative entry would resolve against whatever
    // cwd the hub happens to have been started in.
    return parsed.filter((v): v is string => typeof v === "string" && v.startsWith("/"));
  } catch {
    // missing or corrupt: no added roots, never a failure
    return [];
  }
};

/** Add a folder to the scanned set, returning the new set. Idempotent.
 *
 *  Unlocked read-modify-write, like `registerSession`: two windows adding
 *  different folders in the same instant can leave one of them unrecorded.
 *  Adding a root is a deliberate, rare human action, so the cost of a lock
 *  outweighs a race nobody has hit - and re-adding it works. */
export const addRoot = async (dir: string, rootsPath?: string): Promise<string[]> => {
  const path = rootsFilePath(rootsPath);
  const root = resolve(dir);
  const existing = await readRoots(path);
  if (existing.includes(root)) return existing;
  const next = [...existing, root].sort();
  await writeJsonFile(path, next);
  return next;
};

/** Stop scanning a folder, returning the new set. */
export const removeRoot = async (dir: string, rootsPath?: string): Promise<string[]> => {
  const path = rootsFilePath(rootsPath);
  const root = resolve(dir);
  const existing = await readRoots(path);
  if (!existing.includes(root)) return existing;
  const next = existing.filter((r) => r !== root);
  await writeJsonFile(path, next);
  return next;
};

const isEntry = (value: unknown): value is RegistryEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as RegistryEntry).artifact === "string" &&
  typeof (value as RegistryEntry).name === "string" &&
  typeof (value as RegistryEntry).lastSeen === "string";

/** Read + parse the registry, tolerating a missing or corrupt file (-> []). */
export const readRegistry = async (registryPath?: string): Promise<RegistryEntry[]> => {
  const path = registryFilePath(registryPath);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    // missing or corrupt: an empty registry, never a failure
    return [];
  }
};

const writeRegistry = (path: string, entries: readonly RegistryEntry[]): Promise<void> =>
  writeJsonFile(path, entries);

/**
 * Upsert a pointer for `artifactPath`, keyed by its canonical path, stamping
 * `lastSeen` to now. Written atomically (temp + rename) so a concurrent reader
 * never sees a half-written file.
 */
export const registerSession = async (
  artifactPath: string,
  registryPath?: string,
): Promise<void> => {
  const path = registryFilePath(registryPath);
  const artifact = canonicalArtifactPath(artifactPath);
  const entry: RegistryEntry = {
    artifact,
    name: basename(artifact),
    lastSeen: new Date().toISOString(),
  };
  const others = (await readRegistry(path)).filter((e) => e.artifact !== artifact);
  await writeRegistry(path, [...others, entry]);
};

/** Recover the recorded artifact basename from a session's log, if any. */
const resolveArtifactPath = async (artifactDir: string, stem: string): Promise<string> => {
  // CANONICAL, like every other identity (plan 05, M1.1): a scan that walked in
  // through a symlinked root would otherwise report a second spelling of an
  // artifact the registry already holds, and the listing's union would show
  // one session twice.
  const probe = sessionPaths(resolve(artifactDir, `${stem}.html`));
  try {
    const state = await sessionState(probe);
    if (state.artifact) return canonicalArtifactPath(resolve(artifactDir, state.artifact));
  } catch {
    // unreadable/corrupt log: fall back to the slug-derived name
  }
  return canonicalArtifactPath(resolve(artifactDir, `${stem}.html`));
};

/** Directories a session can never live under, pruned WITHOUT descending -
 *  a glob over all of ~/dev spends nearly all of its time inside
 *  node_modules, and the hub re-scans while a shell is connected. */
const SCAN_PRUNE = new Set(["node_modules", "dist", "build", "target", "vendor"]);

/**
 * Recursively find `<root>/**​/.lucid/*​/log.ndjson` under each root and return
 * the canonical artifact paths (deduped). A hand-rolled walk rather than a
 * glob so pruned subtrees (node_modules, .git, build output) are never
 * ENTERED - Bun.Glob has no exclude, and traversal is the whole cost.
 * Unreadable directories are skipped rather than fatal. Default roots = `~/dev`.
 */
export const scanRoots = async (roots: readonly string[] = defaultRoots()): Promise<string[]> => {
  const found = new Set<string>();

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: skip rather than fail the scan
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!name.startsWith(".")) {
        // `<dir>/<stem>/log.ndjson` - a record folder. In the canonical layout
        // this `<dir>` is a project's `.lucid/` (the walk descends into it
        // below), so `<cwd>/.lucid/<stem>/log.ndjson` is found by exactly this
        // rule, and `resolveArtifactPath` reads the artifact out of the log and
        // resolves it against `.lucid/` - no special case needed (plan 02,
        // MB.2). Not recursed into: inside a record is its own state.
        try {
          await stat(join(dir, name, "log.ndjson"));
          found.add(await resolveArtifactPath(dir, name));
          continue;
        } catch {
          /* no log here: an ordinary directory, keep walking */
        }
      }
      // Prune heavy trees. Descend `.lucid` - that is where canonical records
      // live now - but skip every OTHER dot-directory (.git, .cache, ...),
      // which cannot hold a project's records and dominate the walk time.
      if (SCAN_PRUNE.has(name)) continue;
      if (name.startsWith(".") && name !== ".lucid") continue;
      await walk(join(dir, name));
    }
  };

  for (const root of roots) await walk(resolve(root));
  return [...found];
};

/** ISO mtime of a session's log, or the epoch when it cannot be read. */
const logMtimeIso = async (artifact: string): Promise<string> => {
  try {
    return (await stat(sessionPaths(artifact).logPath)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
};

/** A pointer is alive while ANYTHING of the session remains: its log, or at
 *  least the artifact file. Neither means the session was deleted out from
 *  under the pointer (a cleaned temp dir, an rm -rf'd project). */
const pointerAlive = async (artifact: string): Promise<boolean> => {
  const paths = sessionPaths(artifact);
  try {
    await stat(paths.logPath);
    return true;
  } catch {
    /* no log; the artifact alone still counts */
  }
  try {
    await stat(artifact);
    return true;
  } catch {
    return false;
  }
};

/**
 * Union of the registry file and a fresh `scanRoots` pass, deduped by artifact
 * path. Each entry carries a basename `name` and the best-known `lastSeen` (the
 * later of the registry stamp and the log mtime). Sorted by name.
 *
 * Self-healing: registry pointers whose session no longer exists on disk are
 * dropped from the listing AND pruned from the file (best-effort, atomic) -
 * a pointer index must never make the shell offer sessions that cannot open.
 */
export const listAll = async (
  roots: readonly string[] = defaultRoots(),
  registryPath?: string,
): Promise<RegistryEntry[]> => {
  const byArtifact = new Map<string, RegistryEntry>();
  const consider = (entry: RegistryEntry): void => {
    const existing = byArtifact.get(entry.artifact);
    // ISO strings in the same format compare lexicographically in time order.
    if (!existing || entry.lastSeen > existing.lastSeen) byArtifact.set(entry.artifact, entry);
  };

  const recorded = await readRegistry(registryPath);
  const survivors: RegistryEntry[] = [];
  for (const entry of recorded) {
    if (await pointerAlive(entry.artifact)) {
      survivors.push(entry);
      consider(entry);
    }
  }
  // Prune dead pointers so they stop haunting every later listing. Best
  // effort: a concurrent registerSession can win the race (unlocked
  // read-modify-write, documented), in which case the next pass prunes again.
  if (survivors.length < recorded.length) {
    try {
      await writeRegistry(registryFilePath(registryPath), survivors);
    } catch {
      /* read-only registry: the listing is still clean */
    }
  }

  for (const artifact of await scanRoots(roots)) {
    consider({ artifact, name: basename(artifact), lastSeen: await logMtimeIso(artifact) });
  }
  return [...byArtifact.values()].sort((a, b) => a.name.localeCompare(b.name));
};
