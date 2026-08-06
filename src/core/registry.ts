import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { CONFIG_ENV, configFile } from "./config-paths.ts";
import { writeJsonFile } from "./atomic-json.ts";
import { canonicalArtifactPath, sessionPaths } from "./paths.ts";
import { findRecords, recordPathsFor } from "./records.ts";
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

/** Resolve the registry file path (M1.8): one precedence rule, owned by
 *  `configFile`. */
export const registryFilePath = (registryPath?: string): string =>
  configFile("registry.json", CONFIG_ENV.registry, registryPath);

/**
 * Default discovery roots: `~/dev` for project checkouts, plus this user's
 * agent scratchpads - which is where nearly every artifact actually lives. A
 * project-only default made a machine with a hundred past reviews report none.
 */
export const defaultRoots = (): string[] => [resolve(homedir(), "dev"), ...agentScratchpadRoots()];

/** Resolve the added-roots file path (M1.8): one precedence rule, owned by
 *  `configFile`. */
export const rootsFilePath = (rootsPath?: string): string =>
  configFile("roots.json", CONFIG_ENV.roots, rootsPath);

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

/**
 * Recursively find every review record under each root and return the
 * canonical artifact paths (deduped). Discovery and log->artifact resolution
 * are owned by `core/records.ts` (M1.10); this is the registry's thin read of
 * the one walk. Default roots = `~/dev`.
 */
export const scanRoots = async (roots: readonly string[] = defaultRoots()): Promise<string[]> => {
  const logs = await findRecords(roots);
  const paths = await Promise.all(logs.map(recordPathsFor));
  return [...new Set(paths.map((p) => p.artifactPath))];
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
