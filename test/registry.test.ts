import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath } from "../src/core/paths.ts";
import { listAll, readRegistry, registerSession, scanRoots } from "../src/core/registry.ts";

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-reg-"));
  registryPath = join(dir, "registry.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Seed a session on disk: `<root>/<proj>/.lucid/<name>/log.ndjson`. */
const seedSession = async (root: string, proj: string, name: string): Promise<string> => {
  const artifact = join(root, proj, `${name}.html`);
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
    const registryOnly = join(dir, "loose.html");
    await registerSession(registryOnly, registryPath);

    const all = await listAll([root], registryPath);
    const artifacts = all.map((e) => e.artifact).sort();
    expect(artifacts).toEqual([canonicalArtifactPath(registryOnly), scanned].sort());
    // The shared artifact appears exactly once.
    expect(all.filter((e) => e.artifact === scanned)).toHaveLength(1);
    expect(all.every((e) => e.name === e.artifact.split("/").pop())).toBe(true);
  });

  test("includes a scan-only session the registry never saw", async () => {
    const root = join(dir, "tree");
    const scanned = await seedSession(root, "proj", "solo");
    const all = await listAll([root], registryPath);
    expect(all.map((e) => e.artifact)).toEqual([scanned]);
    expect(all[0]?.name).toBe("solo.html");
  });
});
