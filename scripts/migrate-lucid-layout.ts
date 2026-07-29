/**
 * The portable-review-records migration executor (plan 02, MB.4).
 *
 * Brings every durable record in an inventory to the canonical layout, and is
 * built so a mistake cannot lose review history:
 *  - **rename-only** for the moves, so no bytes are copied or destroyed;
 *  - **dry-run by default** - it prints the exact plan and writes nothing
 *    unless `--apply` is given;
 *  - **refuses the WHOLE run** if any destination already exists, before
 *    touching anything;
 *  - **writes a reversal manifest** (`--apply` only) that `--reverse` replays
 *    backwards to a byte-identical tree, DIRECTORIES included (it removes the
 *    `run/` and new `.lucid/` dirs the forward run created);
 *  - **integrity-checks** every migrated record by comparing before-vs-after -
 *    event count, log hash, snapshot count, seq monotonicity, and any newly
 *    dangling snapshot path are damage THIS run did (they fail it and exit
 *    non-zero); corruption a record carried IN is a warning, never a failure,
 *    since the migration is rename-only and did not cause it.
 *
 * The WHAT (which ops for which record) is the pure `src/core/migration.ts`;
 * this owns the I/O, the refusal, the manifest, and the checks.
 *
 * Usage:
 *   bun run scripts/migrate-lucid-layout.ts --inventory <file> [--apply]
 *   bun run scripts/migrate-lucid-layout.ts --reverse <manifest>
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  invertOp,
  planContainerGitignore,
  planRecordMigration,
  rewriteForkSeedPaths,
  type MigrationOp,
  type RecordMigration,
  type RecordToMigrate,
} from "../src/core/migration.ts";
import type { RecordLayout } from "../src/core/inventory.ts";

interface InventoryRecord {
  readonly artifact: string | null;
  readonly layout: RecordLayout;
  readonly recordPath: string;
  readonly eventCount: number;
  readonly logHash: string;
  readonly ephemeral: boolean;
}

/** A record's committed integrity fingerprint - what the migration must not
 *  change. Computed before and after, and compared. */
interface Integrity {
  readonly eventCount: number;
  readonly logHash: string;
  readonly seqMonotonic: boolean;
  readonly snapshotCount: number;
  readonly versionEventCount: number;
  readonly danglingSnapshotPaths: readonly string[];
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Read a record's committed integrity from disk. */
const integrityOf = async (recordDir: string): Promise<Integrity> => {
  const logPath = join(recordDir, "log.ndjson");
  const text = await readFile(logPath, "utf8").catch(() => "");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const events = lines.map((l) => JSON.parse(l) as { seq?: number; t?: string; path?: string });

  let seqMonotonic = true;
  let prev = -Infinity;
  for (const e of events) {
    if (typeof e.seq === "number") {
      if (e.seq <= prev) seqMonotonic = false;
      prev = e.seq;
    }
  }

  const versionEvents = events.filter((e) => e.t === "version");
  // Every snapshot path ANY event references must resolve to a real file - not
  // just `version` events (a `session_opened` carries the initial snapshot too).
  const dangling: string[] = [];
  for (const e of events) {
    if (e.path && !existsSync(join(recordDir, e.path))) dangling.push(e.path);
  }
  // Count the snapshot files actually on disk under versions/.
  let snapshotCount = 0;
  const versionsDir = join(recordDir, "versions");
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const en of entries) {
      if (en.isDirectory()) await walk(join(dir, en.name));
      else if (en.name.endsWith(".html")) snapshotCount++;
    }
  };
  await walk(versionsDir);

  return {
    eventCount: lines.length,
    logHash: sha256(text),
    seqMonotonic,
    snapshotCount,
    versionEventCount: versionEvents.length,
    danglingSnapshotPaths: dangling,
  };
};

/** Build the planner's input for a record by reading its dir shallowly. */
const toMigrate = async (rec: InventoryRecord): Promise<RecordToMigrate> => {
  const entries = await readdir(rec.recordPath).catch(() => [] as string[]);
  const gitignore = await readFile(join(rec.recordPath, ".gitignore"), "utf8").catch(() => null);
  return {
    recordDir: rec.recordPath,
    artifact: rec.artifact,
    layout: rec.layout,
    entries,
    gitignore,
  };
};

/** Every destination an op would create. A run refuses if ANY already exists. */
const destinationsOf = (ops: readonly MigrationOp[]): string[] =>
  ops.flatMap((op) => (op.kind === "rename" ? [op.to] : []));

/** Apply one op to disk, creating parent dirs as needed. */
const applyOp = async (op: MigrationOp): Promise<void> => {
  if (op.kind === "rename") {
    await mkdir(dirname(op.to), { recursive: true });
    await rename(op.from, op.to);
  } else if (op.kind === "write") {
    await mkdir(dirname(op.path), { recursive: true });
    await writeFile(op.path, op.content);
  } else {
    await rm(op.path, { force: true });
  }
};

/** The final record dir a plan lands on (for fork-seed rewriting + checks). */
const finalRecordDir = (plan: RecordMigration): string => {
  const move = plan.ops.find(
    (o): o is Extract<MigrationOp, { kind: "rename" }> =>
      o.kind === "rename" && o.to.endsWith(join(".lucid", basename(plan.recordDir))),
  );
  return move ? move.to : plan.recordDir;
};

/** The distinct `.lucid/` container dirs the active records land in, and the
 *  delete op for each that carries a bare-`*` `.gitignore` (the container-level
 *  R1 trap). Reads disk; deduplicated by container path. */
const containerGitignoreOps = async (
  active: readonly RecordMigration[],
): Promise<MigrationOp[]> => {
  const containers = new Set(active.map((p) => dirname(finalRecordDir(p))));
  const ops: MigrationOp[] = [];
  for (const container of containers) {
    if (basename(container) !== ".lucid") continue;
    const path = join(container, ".gitignore");
    const content = await readFile(path, "utf8").catch(() => null);
    ops.push(...planContainerGitignore(path, content));
  }
  return ops;
};

/** Rewrite the fork seeds under a migrated record so their absolute paths point
 *  at the new locations (D-013). Returns the reversal ops (write-backs). */
const rewriteForkSeeds = async (
  oldRecordDir: string,
  newRecordDir: string,
  oldArtifact: string,
  newArtifact: string,
): Promise<MigrationOp[]> => {
  const forksDir = join(newRecordDir, "forks");
  // Record-relative targets (D-013): resolved from the FINAL record dir so the
  // seed travels. The seed's absolute paths were written against the OLD record
  // dir / OLD artifact, so those are the prefixes to replace.
  const pairs: [string, string][] = [
    [join(oldRecordDir, "pasted"), "pasted"],
    [oldArtifact, relative(newRecordDir, newArtifact)],
  ];
  const reversal: MigrationOp[] = [];
  let forkIds: string[];
  try {
    forkIds = await readdir(forksDir);
  } catch {
    return reversal; // no forks
  }
  for (const id of forkIds) {
    const seedPath = join(forksDir, id, "seed.md");
    const before = await readFile(seedPath, "utf8").catch(() => null);
    if (before === null) continue;
    const after = rewriteForkSeedPaths(before, pairs);
    if (after === before) continue;
    await writeFile(seedPath, after);
    reversal.push({ kind: "write", path: seedPath, content: before, priorContent: after });
  }
  return reversal;
};

const parseArgs = (argv: string[]) => {
  let inventory: string | undefined;
  let reverse: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--inventory") inventory = argv[++i];
    else if (argv[i] === "--reverse") reverse = argv[++i];
    else if (argv[i] === "--apply") apply = true;
  }
  return { inventory, reverse, apply };
};

export const runReverse = async (manifestPath: string): Promise<void> => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { ops: MigrationOp[] };
  // The manifest already holds the INVERSE ops in reverse order; apply as-is.
  for (const op of manifest.ops) await applyOp(op);

  // Applying the inverse ops moves every file back but leaves the directories
  // the forward run created (`<record>/run`, a sibling's new `<D>/.lucid`) now
  // empty. Byte-identical is not enough - the dir set must match too. Remove
  // exactly those two kinds of dir when empty, deepest-first; rmdir refuses a
  // non-empty dir, so a pre-existing populated `.lucid/` is never touched.
  const dirs = new Set<string>();
  for (const op of manifest.ops) {
    for (const path of op.kind === "rename" ? [op.from, op.to] : [op.path]) {
      const parent = dirname(path);
      if (basename(parent) === "run" || basename(parent) === ".lucid") dirs.add(parent);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => {}); // no-op if absent or non-empty
  }
  console.log(`reversed ${manifest.ops.length} op(s) from ${manifestPath}`);
};

/** The outcome of a migration run. */
export interface MigrationResult {
  readonly migrated: number;
  readonly skipped: number;
  /** Absolute path to the reversal manifest, or null on a dry run. */
  readonly manifestPath: string | null;
  /** Integrity problems THIS run caused, keyed by final record dir; empty =
   *  clean. A non-empty map is a failed run (the caller exits non-zero). */
  readonly problems: Readonly<Record<string, readonly string[]>>;
  /** Pre-existing corruption a record carried IN, keyed by its original dir.
   *  Surfaced so the operator knows, but never fails the run - the migration is
   *  rename-only and did not cause it (and cannot make it worse). */
  readonly warnings: Readonly<Record<string, readonly string[]>>;
}

/**
 * Plan and (when `apply`) execute the migration described by an inventory file.
 * Pure-ish: all disk effects are here, but the WHAT is `planRecordMigration`
 * and the refusal/manifest/integrity policy is explicit. Returns a result the
 * caller (CLI or test) can assert on; throws only on a refusal.
 */
export const runMigration = async (opts: {
  inventoryPath: string;
  apply: boolean;
}): Promise<MigrationResult> => {
  const { inventoryPath, apply } = opts;
  const inv = JSON.parse(await readFile(inventoryPath, "utf8")) as { records: InventoryRecord[] };
  const durable = inv.records.filter((r) => !r.ephemeral);

  const plans: RecordMigration[] = [];
  for (const rec of durable) plans.push(planRecordMigration(await toMigrate(rec)));

  // Refuse the WHOLE run if any destination already exists - before a single
  // move. A half-run that stopped on a collision is the outcome this avoids.
  const collisions = plans.flatMap((p) => destinationsOf(p.ops)).filter((d) => existsSync(d));
  if (collisions.length > 0) {
    throw new Error(`refusing: destination(s) already exist:\n  ${collisions.join("\n  ")}`);
  }

  const active = plans.filter((p) => p.ops.length > 0 && !p.skip);
  const skipped = plans.filter((p) => p.skip);
  const containerOps = await containerGitignoreOps(active);

  console.log(
    `${active.length} record(s) to migrate, ${skipped.length} skipped (orphaned/canonical)`,
  );
  for (const p of skipped) console.log(`  skip ${p.recordDir}: ${p.skip}`);
  for (const p of active) {
    console.log(`  ${p.layout} ${p.recordDir} (${p.ops.length} ops)`);
    if (!apply)
      for (const op of p.ops) console.log(`      ${op.kind} ${JSON.stringify(op).slice(0, 120)}`);
  }
  for (const op of containerOps)
    console.log(`  container ${op.kind} ${op.kind === "delete" ? op.path : ""}`);

  if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to execute.");
    return { migrated: 0, skipped: skipped.length, manifestPath: null, problems: {}, warnings: {} };
  }

  // Live. Integrity before, apply, integrity after, and a reversal manifest.
  const reversal: MigrationOp[] = [];
  const problems: Record<string, string[]> = {};
  const warnings: Record<string, string[]> = {};
  for (const p of active) {
    const oldRecordDir = p.recordDir;
    const inv = durable.find((r) => r.recordPath === oldRecordDir);
    if (!inv || inv.artifact === null) {
      // An active plan always has a non-null artifact (orphans are skipped) -
      // if that ever breaks, refuse rather than default to "" and let an empty
      // prefix corrupt every fork seed (a `"".replaceAll("")` inserts the
      // target between every character).
      throw new Error(`internal: active record ${oldRecordDir} has no inventory artifact`);
    }
    const oldArtifact = inv.artifact;

    const before = await integrityOf(oldRecordDir);
    // Pre-existing corruption is NOT this run's fault - the migration is
    // rename-only. Surface it, but it never fails the run.
    const carried: string[] = [];
    if (!before.seqMonotonic) carried.push("seq not strictly increasing");
    if (before.snapshotCount < before.versionEventCount)
      carried.push("fewer snapshots than version events");
    if (before.danglingSnapshotPaths.length > 0)
      carried.push(`dangling snapshot path(s): ${before.danglingSnapshotPaths.join(", ")}`);
    if (carried.length > 0) {
      warnings[oldRecordDir] = carried;
      console.warn(`PRE-EXISTING (not caused by this run) ${oldRecordDir}: ${carried.join("; ")}`);
    }

    for (const op of p.ops) {
      await applyOp(op);
      reversal.push(invertOp(op));
    }

    const newRecordDir = finalRecordDir(p);
    const newArtifact = join(dirname(newRecordDir), basename(oldArtifact));
    reversal.push(
      ...(await rewriteForkSeeds(oldRecordDir, newRecordDir, oldArtifact, newArtifact)),
    );

    // Migration-induced corruption only: the migration is rename-only, so every
    // committed metric MUST be unchanged; a difference is damage THIS run did.
    const after = await integrityOf(newRecordDir);
    const found: string[] = [];
    if (after.eventCount !== before.eventCount) found.push("event count changed");
    if (after.logHash !== before.logHash) found.push("log bytes changed");
    if (after.snapshotCount !== before.snapshotCount) found.push("snapshot count changed");
    if (before.seqMonotonic && !after.seqMonotonic) found.push("migration broke seq monotonicity");
    const newlyDangling = after.danglingSnapshotPaths.filter(
      (d) => !before.danglingSnapshotPaths.includes(d),
    );
    if (newlyDangling.length > 0)
      found.push(`newly dangling snapshot path(s): ${newlyDangling.join(", ")}`);
    if (found.length > 0) {
      problems[newRecordDir] = found;
      console.error(
        `INTEGRITY FAILURE (caused by this run) for ${newRecordDir}: ${found.join("; ")}`,
      );
    }
  }

  // Delete the container-level R1 traps last (they do not conflict with the
  // record moves), recording each as a restore in the reversal.
  for (const op of containerOps) {
    await applyOp(op);
    reversal.push(invertOp(op));
  }

  // The manifest holds the inverses in REVERSE application order, so replaying
  // it forward undoes the run.
  const manifestPath = `${inventoryPath.replace(/\.json$/, "")}.reversal.json`;
  await writeFile(manifestPath, `${JSON.stringify({ ops: reversal.reverse() }, null, 2)}\n`);
  console.log(`\nmigrated ${active.length} record(s). Reversal manifest: ${manifestPath}`);
  return { migrated: active.length, skipped: skipped.length, manifestPath, problems, warnings };
};

const main = async (): Promise<void> => {
  const { inventory, reverse, apply } = parseArgs(process.argv.slice(2));
  if (reverse) return runReverse(reverse);
  if (!inventory) {
    console.error("usage: --inventory <file> [--apply]  |  --reverse <manifest>");
    process.exit(2);
  }
  try {
    const result = await runMigration({ inventoryPath: inventory, apply });
    // An integrity problem THIS run caused must be visible in the exit status,
    // not just a red line above a green exit - the whole promise is "a mistake
    // cannot lose review history", so a flagged run fails loudly.
    const failed = Object.keys(result.problems).length;
    if (failed > 0) {
      console.error(
        `\n${failed} record(s) failed integrity - see above. The reversal manifest undoes this run.`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
};

if (import.meta.main) await main();
