/**
 * Record-layout classification for the portable-review-records migration.
 *
 * Owns ONE pure decision: given a `log.ndjson` path and which artifact files
 * exist around it, which of the three layouts is this record in? It owns
 * nothing about reading the disk, hashing, or emitting the inventory - those
 * live in `scripts/inventory-lucid-records.ts`, which calls this. The migration
 * (plan 02 MB.4) reuses this same classifier, so a record can never be
 * inventoried as one layout and migrated as another.
 *
 * The three layouts (RFC-01 Terminology):
 *  - `nested`    - the pre-#50 container: `<D>/.lucid/<stem>/log.ndjson` with
 *                  the artifact OUTSIDE the `.lucid` dir (at `<D>/<stem>.<ext>`
 *                  or one level up in a `lucid/` folder).
 *  - `sibling`   - the #50 arrangement: `<D>/<stem>/log.ndjson` beside the
 *                  artifact `<D>/<stem>.<ext>`, no `.lucid` level at all.
 *  - `canonical` - the proposed target: `<D>/.lucid/<stem>/log.ndjson` with the
 *                  artifact INSIDE the same `.lucid` dir (`<D>/.lucid/<stem>.<ext>`).
 *
 * The distinguishing question between `nested` and `canonical` - both put the
 * record under a `.lucid` dir - is where the ARTIFACT sits: inside that same
 * `.lucid` (canonical) or outside it (nested). That is exactly what the
 * migration moves, so it is the right axis to classify on.
 */

import { basename, dirname, join } from "node:path";

export type RecordLayout = "nested" | "sibling" | "canonical" | "unknown";

export interface RecordPaths {
  /** Absolute path to the record's `log.ndjson`. */
  readonly logPath: string;
  /** The stem (record directory name), e.g. `plan` for `plan.html`. */
  readonly stem: string;
  /** The directory holding the `.lucid` dir (nested/canonical), or the
   *  artifact's directory (sibling). Filled by the caller from the tree. */
  readonly artifactDir: string;
}

/**
 * Which absolute paths a caller must `stat` to classify - the artifact file in
 * each candidate location. The caller reports back which exist; classification
 * is then pure. Returned rather than probed here so the decision stays testable
 * without a filesystem.
 */
export interface ArtifactProbe {
  /** `<.lucid dir>/<stem>.<ext>` - present ⟹ canonical. */
  readonly insideLucid: readonly string[];
  /** `<artifactDir>/<stem>.<ext>` - present ⟹ nested (record under .lucid) or
   *  sibling (record beside it). */
  readonly besideRecord: readonly string[];
}

/** Common artifact extensions, in the order a stem is probed. */
export const ARTIFACT_EXTS = [".html", ".md"] as const;

/** The paths whose existence decides the layout for a record under a `.lucid`
 *  dir. `<D>/.lucid/<stem>/log.ndjson`: artifact inside `.lucid` ⟹ canonical,
 *  outside ⟹ nested. */
export const probeForLucidRecord = (logPath: string): ArtifactProbe => {
  const recordDir = dirname(logPath); // <D>/.lucid/<stem>
  const lucidDir = dirname(recordDir); // <D>/.lucid
  const outerDir = dirname(lucidDir); // <D>
  const stem = basename(recordDir);
  return {
    insideLucid: ARTIFACT_EXTS.map((ext) => join(lucidDir, `${stem}${ext}`)),
    besideRecord: ARTIFACT_EXTS.map((ext) => join(outerDir, `${stem}${ext}`)),
  };
};

/**
 * Classify a record whose log sits directly under a `.lucid/<stem>/` directory.
 * `existing` is the set of probe paths (from `probeForLucidRecord`) that exist
 * on disk. Canonical when the artifact is inside `.lucid`; nested when it is
 * outside; unknown when neither is found (an orphaned record - listed, never
 * adopted, per D-011).
 */
export const classifyLucidRecord = (
  probe: ArtifactProbe,
  existing: ReadonlySet<string>,
): RecordLayout => {
  if (probe.insideLucid.some((p) => existing.has(p))) return "canonical";
  if (probe.besideRecord.some((p) => existing.has(p))) return "nested";
  return "unknown";
};
