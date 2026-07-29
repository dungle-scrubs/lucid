/**
 * The portable-review-records migration, as PURE data (plan 02, MB.4).
 *
 * `planRecordMigration` turns one inventoried record into an ordered list of
 * filesystem operations that bring it to the canonical layout - and nothing
 * else: it reads no disk, mutates nothing, and every operation it emits is
 * REVERSIBLE, which is what lets the executor write a manifest that replays
 * backwards to a byte-identical tree (RFC-01 Rollback). The executor
 * (`scripts/migrate-lucid-layout.ts`) owns the I/O; this owns WHAT to do.
 *
 * The canonical target (RFC-01): both the artifact and its record live under
 * `<cwd>/.lucid/` - `<cwd>/.lucid/<stem>.html` beside `<cwd>/.lucid/<stem>/`.
 *  - `nested`    - record already under `.lucid/`, artifact OUTSIDE it: move the
 *                  ARTIFACT in. The record does not move.
 *  - `sibling`   - record beside the artifact, no `.lucid/`: move BOTH into a
 *                  new `.lucid/`.
 *  - `canonical` - already there: nothing to move.
 *  - `unknown`   - orphaned (artifact gone): reported, never adopted (D-011).
 */

import { basename, dirname, join } from "node:path";
import type { RecordLayout } from "./inventory.ts";

/** One reversible filesystem operation. `rename` inverts by swapping from/to;
 *  `write`/`delete` carry the prior content (if any) so the inverse restores
 *  exactly what was there - including "the file did not exist" (priorContent
 *  null → the inverse deletes it). */
export type MigrationOp =
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly content: string;
      /** The bytes that were there before, or null when the file is new. */
      readonly priorContent: string | null;
    }
  | { readonly kind: "delete"; readonly path: string; readonly priorContent: string };

export interface RecordMigration {
  readonly recordDir: string;
  readonly layout: RecordLayout;
  /** The operations, in the order the executor must apply them. */
  readonly ops: readonly MigrationOp[];
  /** Set when nothing is done - an orphaned record (D-011) or one already
   *  canonical. The record is listed, not touched. */
  readonly skip?: string;
}

/** What the planner needs to know about a record - the inventory's shape, plus
 *  the machine-local files present in the record dir (so runtime files are
 *  relocated into run/ and content files are left alone). */
export interface RecordToMigrate {
  /** Absolute path to the record dir, e.g. `<D>/.lucid/plan` or `<D>/plan`. */
  readonly recordDir: string;
  /** Absolute path to the artifact, or null for an orphaned record. */
  readonly artifact: string | null;
  readonly layout: RecordLayout;
  /** Names (not paths) of entries directly inside the record dir. Used to
   *  decide which runtime files to relocate; content entries are left. */
  readonly entries: readonly string[];
  /** Bytes of the record's existing `.gitignore`, or null when absent. */
  readonly gitignore: string | null;
}

/** Entries that STAY at the record root (committed history). Everything else
 *  in the record dir is machine-local and moves under `run/`. */
const CONTENT_ENTRIES = new Set(["log.ndjson", "versions", "pasted", "forks", ".gitignore", "run"]);

/** The canonical `.lucid/` dir for a record's containing project. */
const lucidDirFor = (layout: RecordLayout, recordDir: string): string =>
  // nested/canonical: recordDir is already `<D>/.lucid/<stem>`, so its parent
  // is the `.lucid/`. sibling: recordDir is `<D>/<stem>`, and the `.lucid/`
  // is a NEW dir beside it.
  layout === "sibling" ? join(dirname(recordDir), ".lucid") : dirname(recordDir);

/**
 * Plan one record's migration. Pure: the caller supplies the record's shape
 * (from the inventory + a shallow read of its dir) and gets back the ordered,
 * reversible operations - or a skip. It never decides existence conflicts;
 * that is the executor's refusal, checked against the real tree.
 */
export const planRecordMigration = (record: RecordToMigrate): RecordMigration => {
  const { recordDir, artifact, layout, entries, gitignore } = record;
  if (layout === "unknown" || artifact === null) {
    return {
      recordDir,
      layout,
      ops: [],
      skip: "orphaned - artifact not found; listed, never adopted",
    };
  }
  if (layout === "canonical") {
    // Already canonical; only ensure the ignore is the `run/` form and runtime
    // files are under run/. If both already hold, this yields no ops.
    return {
      recordDir,
      layout,
      ops: [...runtimeMoves(recordDir, entries), ...gitignoreOp(recordDir, gitignore)],
    };
  }

  const stem = basename(recordDir);
  const lucidDir = lucidDirFor(layout, recordDir);
  const ops: MigrationOp[] = [];

  // The artifact moves INTO .lucid/ in both nested and sibling. (For nested the
  // record already lives in .lucid/; for sibling it moves too, below.)
  const artifactDest = join(lucidDir, basename(artifact));
  if (artifact !== artifactDest) ops.push({ kind: "rename", from: artifact, to: artifactDest });

  // sibling: the record dir itself moves into the new .lucid/.
  const finalRecordDir = layout === "sibling" ? join(lucidDir, stem) : recordDir;
  if (finalRecordDir !== recordDir) {
    ops.push({ kind: "rename", from: recordDir, to: finalRecordDir });
  }

  ops.push(...runtimeMoves(finalRecordDir, entries));
  ops.push(...gitignoreOp(finalRecordDir, gitignore));
  return { recordDir, layout, ops };
};

/** Relocate each machine-local entry at the record root into `run/`. */
const runtimeMoves = (recordDir: string, entries: readonly string[]): MigrationOp[] =>
  entries
    .filter((e) => !CONTENT_ENTRIES.has(e))
    .map((e) => ({
      kind: "rename" as const,
      from: join(recordDir, e),
      to: join(recordDir, "run", e),
    }));

/** Rewrite the record's `.gitignore` to exactly `run/` when it differs. A bare
 *  `*` (the old self-ignore) is the R1 trap and must go; an absent or already
 *  `run/` file that matches yields no op. */
const gitignoreOp = (recordDir: string, gitignore: string | null): MigrationOp[] => {
  const want = "run/\n";
  if (gitignore === want) return [];
  return [
    { kind: "write", path: join(recordDir, ".gitignore"), content: want, priorContent: gitignore },
  ];
};

/**
 * The R1 trap at the CONTAINER level: a bare-`*` `<D>/.lucid/.gitignore` ignores
 * the entire `.lucid/` tree, so the review records it now holds would be
 * invisible to git - defeating the portability goal. Delete it, recording its
 * prior bytes so the reversal restores it (the one non-renameable act). Anything
 * other than a bare `*` is a deliberate ignore the migration leaves alone.
 *
 * Pure: the executor reads the real `<D>/.lucid/.gitignore` and passes its bytes
 * (null when absent). Deduplicate by container dir before calling.
 */
export const planContainerGitignore = (
  lucidGitignorePath: string,
  content: string | null,
): MigrationOp[] =>
  content !== null && content.trim() === "*"
    ? [{ kind: "delete", path: lucidGitignorePath, priorContent: content }]
    : [];

/**
 * A fork seed carries ABSOLUTE paths (`writeForkSeed`) - to the parent artifact
 * and to pasted images under the record dir - which is exactly what breaks when
 * the record travels to another machine. Rewrite each absolute prefix to a
 * RECORD-RELATIVE one so the seed resolves wherever the record lands (D-013):
 * the executor passes `[<oldAbsolutePrefix>, <relativePrefix>]` pairs it
 * computed from the moves (e.g. the artifact → `../<stem>.html`, the pasted dir
 * → `pasted`).
 *
 * Longest-prefix first, so rewriting `<recordDir>` does not also mangle a path
 * that begins with `<recordDir>` but was already covered by a more specific
 * pair.
 */
export const rewriteForkSeedPaths = (
  seed: string,
  replacements: readonly (readonly [string, string])[],
): string =>
  [...replacements]
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((s, [from, to]) => s.replaceAll(from, to), seed);

/** Invert an operation for the reversal manifest. */
export const invertOp = (op: MigrationOp): MigrationOp => {
  switch (op.kind) {
    case "rename":
      return { kind: "rename", from: op.to, to: op.from };
    case "write":
      return op.priorContent === null
        ? { kind: "delete", path: op.path, priorContent: op.content }
        : { kind: "write", path: op.path, content: op.priorContent, priorContent: op.content };
    case "delete":
      return { kind: "write", path: op.path, content: op.priorContent, priorContent: null };
  }
};
