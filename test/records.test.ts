import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_EXTS } from "../src/core/inventory.ts";
import { canonicalArtifactPath } from "../src/core/paths.ts";
import { findRecords, recordPathsFor } from "../src/core/records.ts";

/**
 * M1.10: one owner for record discovery. Three sites walked roots for
 * `log.ndjson` with three prune lists and three log->artifact resolutions;
 * `records.ts` owns the walk (`findRecords`) and the resolution
 * (`recordPathsFor`) so a record found by any consumer agrees with one found
 * by any other.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-records-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Seed a CANONICAL record: `<root>/<proj>/.lucid/<name>/log.ndjson` with the
 *  artifact `<root>/<proj>/.lucid/<name>.<ext>` recorded in its open event. */
const seedRecord = async (
  root: string,
  proj: string,
  name: string,
  ext: string = ".html",
): Promise<{ log: string; artifact: string }> => {
  const lucid = join(root, proj, ".lucid");
  const sessionDir = join(lucid, name);
  const artifact = join(lucid, `${name}${ext}`);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(artifact, "<h1>x</h1>");
  const opened = {
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    t: "session_opened",
    segment: 1,
    version: 1,
    artifact: `${name}${ext}`,
    hash: "h",
    path: `versions/s1/v1.html`,
  };
  const log = join(sessionDir, "log.ndjson");
  await writeFile(log, `${JSON.stringify(opened)}\n`);
  return { log, artifact: canonicalArtifactPath(artifact) };
};

describe("findRecords", () => {
  test("finds a canonical record's log under a root", async () => {
    const { log } = await seedRecord(dir, "proj", "notes");
    const found = await findRecords([dir]);
    expect(found).toContain(log);
  });

  test("prunes heavy trees so a record under node_modules is never walked", async () => {
    // One real record, and a decoy buried in node_modules. The decoy would be
    // found by an unpruned glob (the sessions listing used to walk every
    // dependency tree); the one prune list skips it.
    const real = await seedRecord(dir, "proj", "real");
    await seedRecord(join(dir, "proj", "node_modules"), "dep", "decoy");
    const found = await findRecords([dir]);
    expect(found).toContain(real.log);
    expect(found.some((l) => l.includes("decoy"))).toBe(false);
  });

  test("prunes dot-directories except .lucid", async () => {
    // .lucid IS descended (records live there); .git and .cache are not.
    const real = await seedRecord(dir, "proj", "notes");
    await seedRecord(join(dir, "proj", ".git"), "x", "gitdecoy");
    const found = await findRecords([dir]);
    expect(found).toContain(real.log);
    expect(found.some((l) => l.includes("gitdecoy"))).toBe(false);
  });

  test("dedupes a record reachable through two roots", async () => {
    const { log } = await seedRecord(dir, "proj", "notes");
    // The same tree reachable via two root spellings (a real symlink, the way
    // /tmp and /private/tmp are one place on macOS).
    const link = join(dir, "link");
    await symlink(dir, link);
    const found = await findRecords([dir, link]);
    expect(found.filter((l) => l === log)).toHaveLength(1);
  });

  test("skips an unreadable root rather than failing", async () => {
    const { log } = await seedRecord(dir, "proj", "notes");
    const found = await findRecords([dir, join(dir, "nope")]);
    expect(found).toEqual([log]);
  });
});

describe("recordPathsFor", () => {
  test("resolves a discovered log to its artifact's SessionPaths", async () => {
    const { log, artifact } = await seedRecord(dir, "proj", "notes");
    const paths = await recordPathsFor(log);
    expect(paths.artifactPath).toBe(artifact);
  });

  test("resolves a .md artifact from its recorded open event", async () => {
    // The log records the real basename; a .md artifact is found, not assumed
    // .html. (ARTIFACT_EXTS is the extension vocabulary the record may use.)
    expect(ARTIFACT_EXTS).toContain(".md");
    const { log, artifact } = await seedRecord(dir, "proj", "plan", ".md");
    const paths = await recordPathsFor(log);
    expect(paths.artifactPath).toBe(artifact);
    expect(paths.artifactPath.endsWith(".md")).toBe(true);
  });

  test("falls back to the stem-derived name when the log is empty", async () => {
    const sessionDir = join(dir, "proj", ".lucid", "orphan");
    await mkdir(sessionDir, { recursive: true });
    // The artifact exists but the log never recorded an open event - the
    // record predates the stamp. recordPathsFor probes the extension
    // vocabulary and finds it.
    await writeFile(join(dir, "proj", ".lucid", "orphan.html"), "<h1>x</h1>");
    const log = join(sessionDir, "log.ndjson");
    await writeFile(log, "");
    const paths = await recordPathsFor(log);
    expect(paths.artifactPath).toBe(
      canonicalArtifactPath(join(dir, "proj", ".lucid", "orphan.html")),
    );
  });

  test("canonicalizes a symlinked artifact path", async () => {
    const { log } = await seedRecord(dir, "proj", "notes");
    // Reach the same record through a symlinked root: recordPathsFor returns
    // the canonical (realpath'd) artifact, not the symlink spelling.
    const link = join(dir, "link");
    await symlink(dir, link);
    const linkedLog = log.replace(dir, link);
    const paths = await recordPathsFor(linkedLog);
    const direct = await recordPathsFor(log);
    expect(paths.artifactPath).toBe(direct.artifactPath);
    // And it is the realpath, not a spelling carrying the symlink.
    expect(paths.artifactPath).not.toContain("/link/");
  });
});
