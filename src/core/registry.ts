import { randomUUID } from "node:crypto";
import { Glob } from "bun";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { foldLog } from "./fold.ts";
import { readEvents } from "./log.ts";
import { canonicalArtifactPath, sessionPaths } from "./paths.ts";

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

/** Default discovery roots: `~/dev` expanded via the home directory. */
export const defaultRoots = (): string[] => [resolve(homedir(), "dev")];

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

/** Atomic write: serialize to a sibling temp file, then rename into place. */
const writeRegistry = async (path: string, entries: readonly RegistryEntry[]): Promise<void> => {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.registry.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, path);
};

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
  const probe = sessionPaths(resolve(artifactDir, `${stem}.html`));
  try {
    const state = foldLog((await readEvents(probe.logPath)).events);
    if (state.artifact) return resolve(artifactDir, state.artifact);
  } catch {
    // unreadable/corrupt log: fall back to the slug-derived name
  }
  return resolve(artifactDir, `${stem}.html`);
};

/**
 * Recursively find `<root>/**​/.lucid/*​/log.ndjson` under each root and return
 * the canonical artifact paths (deduped). Unreadable roots are skipped rather
 * than fatal. Default roots = `~/dev`.
 */
export const scanRoots = async (roots: readonly string[] = defaultRoots()): Promise<string[]> => {
  const found = new Set<string>();
  for (const root of roots) {
    const scanRoot = resolve(root);
    const glob = new Glob("**/.lucid/*/log.ndjson");
    try {
      for await (const rel of glob.scan({ cwd: scanRoot, dot: true, onlyFiles: true })) {
        const parts = rel.split("/");
        const idx = parts.lastIndexOf(".lucid");
        const stem = parts[idx + 1];
        if (idx === -1 || stem === undefined) continue;
        const artifactDir = resolve(scanRoot, ...parts.slice(0, idx));
        found.add(await resolveArtifactPath(artifactDir, stem));
      }
    } catch {
      // unreadable root: skip rather than fail the scan
    }
  }
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

/**
 * Union of the registry file and a fresh `scanRoots` pass, deduped by artifact
 * path. Each entry carries a basename `name` and the best-known `lastSeen` (the
 * later of the registry stamp and the log mtime). Sorted by name.
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
  for (const entry of await readRegistry(registryPath)) consider(entry);
  for (const artifact of await scanRoots(roots)) {
    consider({ artifact, name: basename(artifact), lastSeen: await logMtimeIso(artifact) });
  }
  return [...byArtifact.values()].sort((a, b) => a.name.localeCompare(b.name));
};
