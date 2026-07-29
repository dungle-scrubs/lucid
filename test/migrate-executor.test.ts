import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runMigration, runReverse } from "../scripts/migrate-lucid-layout.ts";

/**
 * The migration EXECUTOR against real fixture trees (plan 02, MB.4).
 *
 * The planner is unit-tested as pure data; this proves the I/O half keeps the
 * two promises that make the migration safe to run on a human's review
 * history: it never moves bytes it cannot put back (the reversal restores a
 * BYTE-IDENTICAL tree), and it refuses rather than half-runs when a
 * destination is occupied. The named mutations red exactly those two.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const write = async (path: string, content: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
};

/** A nested record (artifact OUTSIDE .lucid) and a sibling record (beside its
 *  artifact, no .lucid), each with committed history + machine-local runtime
 *  files, plus an inventory file describing them. Returns the paths. */
const buildTree = async () => {
  const root = await mkdtemp(join(tmpdir(), "lucid-migrate-"));
  roots.push(root);

  // nested: <root>/a/.lucid/alpha  with artifact at <root>/a/alpha.html
  const nestedDir = join(root, "a", ".lucid", "alpha");
  const nestedLog =
    '{"seq":1,"t":"session_opened"}\n{"seq":2,"t":"version","path":"versions/0002.html"}\n';
  await write(join(nestedDir, "log.ndjson"), nestedLog);
  await write(join(nestedDir, "versions", "0002.html"), "<h1>alpha v2</h1>");
  await write(join(nestedDir, "server.json"), '{"port":1}'); // runtime -> run/
  await write(join(nestedDir, "current.html"), "<h1>alpha now</h1>"); // runtime -> run/
  await write(join(root, "a", "alpha.html"), "<h1>alpha artifact</h1>");
  // the container-level R1 trap: <root>/a/.lucid/.gitignore = * hides everything
  await write(join(root, "a", ".lucid", ".gitignore"), "*\n");

  // sibling: <root>/b/beta beside artifact <root>/b/beta.html, with a fork seed
  const sibDir = join(root, "b", "beta");
  const sibLog = '{"seq":1,"t":"version","path":"versions/0001.html"}\n';
  await write(join(sibDir, "log.ndjson"), sibLog);
  await write(join(sibDir, "versions", "0001.html"), "<h1>beta v1</h1>");
  await write(join(sibDir, ".gitignore"), "*\n"); // the R1 trap -> run/
  const sibArtifact = join(root, "b", "beta.html");
  await write(sibArtifact, "<h1>beta artifact</h1>");
  // a fork seed in the real shape (writeForkSeed): absolute artifact + pasted
  // image paths at the OLD locations, which the migration makes record-relative
  await write(join(sibDir, "pasted", "a1.png"), "png-bytes");
  await write(
    join(sibDir, "forks", "f1", "seed.md"),
    `**Source artifact:** ${sibArtifact} (v1)\n\n**Attached images:**\n- a1.png: ${join(sibDir, "pasted", "a1.png")}\n`,
  );

  const inventoryPath = join(root, "inventory.json");
  await writeFile(
    inventoryPath,
    JSON.stringify({
      records: [
        {
          artifact: join(root, "a", "alpha.html"),
          layout: "nested",
          recordPath: nestedDir,
          eventCount: 3,
          logHash: "",
          ephemeral: false,
        },
        {
          artifact: sibArtifact,
          layout: "sibling",
          recordPath: sibDir,
          eventCount: 1,
          logHash: "",
          ephemeral: false,
        },
        // an ephemeral record the executor must ignore entirely
        {
          artifact: join(root, "scratch.html"),
          layout: "sibling",
          recordPath: join(root, "scratch"),
          eventCount: 0,
          logHash: "",
          ephemeral: true,
        },
      ],
    }),
  );

  return { root, inventoryPath, nestedDir, sibDir };
};

/** Snapshot every file AND directory under a dir, for exact before/after
 *  comparison. Directories are recorded as `<dir>/` -> "" so the reversal test
 *  catches an emptied-but-orphaned dir, not just changed file bytes. */
const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const en of await readdir(d, { withFileTypes: true })) {
      const p = join(d, en.name);
      if (en.isDirectory()) {
        out[`${relative(dir, p)}/`] = "";
        await walk(p);
      } else out[relative(dir, p)] = await readFile(p, "utf8");
    }
  };
  await walk(dir);
  return out;
};

describe("migrate executor", () => {
  test("dry run (default) writes nothing", async () => {
    const { root, inventoryPath } = await buildTree();
    const before = await snapshot(root);
    const result = await runMigration({ inventoryPath, apply: false });
    expect(result.manifestPath).toBeNull();
    expect(await snapshot(root)).toEqual(before);
  });

  test("apply moves artifacts+records to canonical, runtime under run/, ignoring ephemeral", async () => {
    const { root, inventoryPath } = await buildTree();
    const result = await runMigration({ inventoryPath, apply: true });
    expect(result.migrated).toBe(2);
    expect(result.problems).toEqual({});

    // nested: artifact moved INTO .lucid, record stayed, runtime under run/
    expect(existsSync(join(root, "a", ".lucid", "alpha.html"))).toBe(true);
    expect(existsSync(join(root, "a", "alpha.html"))).toBe(false);
    expect(existsSync(join(root, "a", ".lucid", "alpha", "run", "server.json"))).toBe(true);
    expect(existsSync(join(root, "a", ".lucid", "alpha", "server.json"))).toBe(false);
    // committed history is never relocated
    expect(existsSync(join(root, "a", ".lucid", "alpha", "log.ndjson"))).toBe(true);

    // sibling: BOTH moved into a new .lucid, gitignore rewritten to run/
    expect(existsSync(join(root, "b", ".lucid", "beta.html"))).toBe(true);
    expect(existsSync(join(root, "b", ".lucid", "beta", "log.ndjson"))).toBe(true);
    expect(await readFile(join(root, "b", ".lucid", "beta", ".gitignore"), "utf8")).toBe("run/\n");

    // the fork seed's absolute paths became record-relative so it travels (D-013)
    const seed = await readFile(
      join(root, "b", ".lucid", "beta", "forks", "f1", "seed.md"),
      "utf8",
    );
    expect(seed).toContain("**Source artifact:** ../beta.html (v1)");
    expect(seed).toContain("- a1.png: pasted/a1.png");
    expect(seed).not.toContain(root); // no absolute path leaks through

    // the container-level R1 trap was deleted so git can see the records
    expect(existsSync(join(root, "a", ".lucid", ".gitignore"))).toBe(false);

    // ephemeral record untouched (it never existed on disk; nothing created)
    expect(existsSync(join(root, "scratch"))).toBe(false);
  });

  test("the reversal manifest replays backwards to a byte-identical tree", async () => {
    const { root, inventoryPath } = await buildTree();
    const before = await snapshot(root);
    const result = await runMigration({ inventoryPath, apply: true });
    // the manifest itself is not part of the tree we compare
    const manifest = result.manifestPath;
    expect(manifest).not.toBeNull();
    if (!manifest) throw new Error("no manifest");

    await runReverse(manifest);
    const after = await snapshot(root);
    // drop the inventory + manifest, which live at the root and are not record
    // bytes, from both sides.
    for (const k of Object.keys(after)) if (k.endsWith(".json")) delete after[k];
    const beforeRecords = { ...before };
    for (const k of Object.keys(beforeRecords)) if (k.endsWith(".json")) delete beforeRecords[k];
    expect(after).toEqual(beforeRecords);
  });

  // MUTATION (drop the destination-exists refusal): with a destination already
  // occupied, a tool that does NOT refuse would start moving and corrupt the
  // tree. This asserts the refusal throws before touching anything.
  test("refuses the whole run when any destination already exists", async () => {
    const { root, inventoryPath } = await buildTree();
    // pre-create the nested artifact's destination
    await write(join(root, "a", ".lucid", "alpha.html"), "occupied");
    const before = await snapshot(root);
    await expect(runMigration({ inventoryPath, apply: true })).rejects.toThrow(/already exist/);
    // nothing moved
    expect(await snapshot(root)).toEqual(before);
  });

  // Pre-existing corruption is the record's, not the run's: a rename-only
  // migration cannot fix it and must not be BLAMED for it. It surfaces as a
  // warning, the run still succeeds (empty problems), and the exit stays clean.
  test("pre-existing corruption is a warning, never a run failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucid-migrate-"));
    roots.push(root);
    // A sibling record whose log references a snapshot that is NOT on disk.
    const recDir = join(root, "broken");
    await write(
      join(recDir, "log.ndjson"),
      '{"seq":1,"t":"version","path":"versions/gone.html"}\n',
    );
    await write(join(root, "broken.html"), "<h1>broken</h1>");
    const inventoryPath = join(root, "inv.json");
    await writeFile(
      inventoryPath,
      JSON.stringify({
        records: [
          {
            artifact: join(root, "broken.html"),
            layout: "sibling",
            recordPath: recDir,
            eventCount: 1,
            logHash: "",
            ephemeral: false,
          },
        ],
      }),
    );

    const result = await runMigration({ inventoryPath, apply: true });
    expect(result.migrated).toBe(1);
    expect(result.problems).toEqual({}); // the run caused nothing
    expect(Object.keys(result.warnings)).toEqual([recDir]); // but it flags the carry-in
    expect(result.warnings[recDir]?.join(" ")).toContain("dangling");
  });

  // MUTATION (drop the manifest write): apply must return a manifest path and
  // write the file; without it there is no way to reverse.
  test("apply writes a reversal manifest file", async () => {
    const { inventoryPath } = await buildTree();
    const result = await runMigration({ inventoryPath, apply: true });
    expect(result.manifestPath).not.toBeNull();
    if (!result.manifestPath) throw new Error("no manifest");
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(Array.isArray(manifest.ops)).toBe(true);
    expect(manifest.ops.length).toBeGreaterThan(0);
  });
});
