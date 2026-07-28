import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath } from "../src/core/paths.ts";
import {
  addRoot,
  listAll,
  readRegistry,
  readRoots,
  registerSession,
  removeRoot,
  scanRoots,
} from "../src/core/registry.ts";

let dir: string;
let registryPath: string;
let rootsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-reg-"));
  registryPath = join(dir, "registry.json");
  rootsPath = join(dir, "roots.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Seed a CANONICAL record on disk (plan 02): artifact AND record both under
 *  `<root>/<proj>/.lucid/` - `.lucid/<name>.html` beside `.lucid/<name>/`. */
const seedSession = async (root: string, proj: string, name: string): Promise<string> => {
  const artifact = join(root, proj, ".lucid", `${name}.html`);
  const sessionDir = join(root, proj, ".lucid", name);
  await mkdir(sessionDir, { recursive: true });
  const opened = {
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    t: "session_opened",
    segment: 1,
    version: 1,
    artifact: `${name}.html`,
    hash: "h",
    path: `versions/s1/v1.html`,
  };
  await writeFile(join(sessionDir, "log.ndjson"), `${JSON.stringify(opened)}\n`);
  return canonicalArtifactPath(artifact);
};

describe("registry read/write", () => {
  test("register then read round-trips an entry keyed by canonical path", async () => {
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, "<html></html>");
    await registerSession(artifact, registryPath);

    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.artifact).toBe(canonicalArtifactPath(artifact));
    expect(entries[0]?.name).toBe("plan.html");
    expect(typeof entries[0]?.lastSeen).toBe("string");
    expect(Number.isNaN(Date.parse(entries[0]!.lastSeen))).toBe(false);
  });

  test("re-registering the same artifact upserts (no duplicate)", async () => {
    const artifact = join(dir, "plan.html");
    await registerSession(artifact, registryPath);
    const first = (await readRegistry(registryPath))[0]?.lastSeen;
    await new Promise((r) => setTimeout(r, 5));
    await registerSession(artifact, registryPath);
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.lastSeen).not.toBe(first);
  });

  test("a missing registry reads as []", async () => {
    expect(await readRegistry(join(dir, "does-not-exist.json"))).toEqual([]);
  });

  test("a corrupt registry reads as []", async () => {
    await writeFile(registryPath, "{ this is not json");
    expect(await readRegistry(registryPath)).toEqual([]);
  });

  test("a non-array registry reads as []", async () => {
    await writeFile(registryPath, JSON.stringify({ not: "an array" }));
    expect(await readRegistry(registryPath)).toEqual([]);
  });
});

describe("added roots", () => {
  test("a missing roots file reads as []", async () => {
    expect(await readRoots(join(dir, "nope.json"))).toEqual([]);
  });

  test("a corrupt roots file reads as []", async () => {
    await writeFile(rootsPath, "{ not json");
    expect(await readRoots(rootsPath)).toEqual([]);
  });

  test("add persists a folder, and adding it twice is a no-op", async () => {
    await addRoot(dir, rootsPath);
    expect(await readRoots(rootsPath)).toEqual([dir]);
    await addRoot(dir, rootsPath);
    expect(await readRoots(rootsPath)).toEqual([dir]);
  });

  test("relative entries are ignored - they would resolve against the hub's cwd", async () => {
    await writeFile(rootsPath, JSON.stringify(["../sneaky", "not/absolute", dir]));
    expect(await readRoots(rootsPath)).toEqual([dir]);
  });

  test("remove stops scanning a folder, and removing an absent one is a no-op", async () => {
    const other = join(dir, "other");
    await mkdir(other, { recursive: true });
    await addRoot(dir, rootsPath);
    await addRoot(other, rootsPath);
    expect(await removeRoot(dir, rootsPath)).toEqual([other]);
    expect(await removeRoot(dir, rootsPath)).toEqual([other]);
    expect(await readRoots(rootsPath)).toEqual([other]);
  });

  test("an added folder's existing sessions are discoverable - the point of adding it", async () => {
    // The folder holds a session BEFORE it is ever added: this is the "my old
    // reviews are invisible" case, where the default root never covered them.
    const root = join(dir, "elsewhere");
    const artifact = await seedSession(root, "proj", "old-plan");
    await addRoot(root, rootsPath);

    const roots = await readRoots(rootsPath);
    expect(await scanRoots(roots)).toEqual([artifact]);
  });

  test("a session directly in the added folder counts, not only one nested under it", async () => {
    // `<folder>/.lucid/<stem>/log.ndjson` - what a human means by "add this
    // project", where the artifact sits at the project root.
    const root = join(dir, "flat");
    const artifact = await seedSession(root, ".", "notes");
    await addRoot(root, rootsPath);
    expect(await scanRoots(await readRoots(rootsPath))).toEqual([artifact]);
  });
});

describe("scanRoots", () => {
  test("finds a session under a temp root and returns its canonical artifact path", async () => {
    const root = join(dir, "tree");
    const artifact = await seedSession(root, "proj", "notes");
    const found = await scanRoots([root]);
    expect(found).toContain(artifact);
    expect(found).toHaveLength(1);
  });

  test("skips an unreadable root rather than failing", async () => {
    const root = join(dir, "tree");
    const artifact = await seedSession(root, "proj", "notes");
    const found = await scanRoots([root, join(dir, "nope-not-here")]);
    expect(found).toEqual([artifact]);
  });
});

describe("listAll", () => {
  test("unions the registry and a scan, deduped by artifact path", async () => {
    const root = join(dir, "tree");
    const scanned = await seedSession(root, "proj", "notes");
    // Register the SAME artifact that the scan will also find, plus a second
    // artifact that only exists in the registry.
    await registerSession(scanned, registryPath);
    // A registry-only pointer must point at something that EXISTS - dead
    // pointers are pruned (self-healing), so give it a real artifact file.
    const registryOnly = join(dir, "loose.html");
    await writeFile(registryOnly, "<h1>loose</h1>");
    await registerSession(registryOnly, registryPath);

    const all = await listAll([root], registryPath);
    const artifacts = all.map((e) => e.artifact).sort();
    expect(artifacts).toEqual([canonicalArtifactPath(registryOnly), scanned].sort());
    // The shared artifact appears exactly once.
    expect(all.filter((e) => e.artifact === scanned)).toHaveLength(1);
    expect(all.every((e) => e.name === e.artifact.split("/").pop())).toBe(true);
  });

  test("a dead pointer is dropped from the listing AND pruned from the file", async () => {
    const root = join(dir, "tree");
    const scanned = await seedSession(root, "proj", "notes");
    // Register a session whose files then vanish (a cleaned temp dir).
    const ghost = join(dir, "ghost.html");
    await writeFile(ghost, "<h1>ghost</h1>");
    await registerSession(ghost, registryPath);
    await rm(ghost);

    const all = await listAll([root], registryPath);
    expect(all.map((e) => e.artifact)).toEqual([scanned]);
    // Self-healed: the pointer is gone from the registry file too, so it
    // cannot haunt the next listing.
    const remaining = await readRegistry(registryPath);
    expect(remaining.some((e) => e.artifact === canonicalArtifactPath(ghost))).toBe(false);
  });

  test("includes a scan-only session the registry never saw", async () => {
    const root = join(dir, "tree");
    const scanned = await seedSession(root, "proj", "solo");
    const all = await listAll([root], registryPath);
    expect(all.map((e) => e.artifact)).toEqual([scanned]);
    expect(all[0]?.name).toBe("solo.html");
  });
});
