/**
 * Where a lost note pointed (3e): the seam's placement.
 *
 * The seam sits in the gap a removed passage left. Only a diff can name that
 * gap: the note's selectors name an element of the version the note was
 * written against, so that version's bytes are walked for the block the note
 * hung from, and the same walk that reports what changed says where the next
 * surviving block went. The seam goes before that one; nothing after it
 * survived means the seam goes last.
 *
 * Not every lost note earns a seam. One whose selectors name nothing the old
 * bytes hold has no place to put it, and a block that survived - reworded,
 * moved - is not a gone passage; it is a note that failed to re-anchor, which
 * is a different fact with no seam to draw. A seam in the wrong gap would be
 * worse than none.
 *
 * Extracted from the page so the placement is proven against documents rather
 * than trusted from the one place it runs.
 */
import type { SpotSelectors } from "./anchor.js";
import { collectBlocks, diffVersions } from "./version-diff.js";

/** A lost spot, as the re-anchoring walk saw it. */
export interface LostSpot {
  readonly fromVersion: number;
  readonly selectors: SpotSelectors | undefined;
}

/** One seam to draw: before a block index, with a label, opening a version. */
export interface SeamSpec {
  readonly before: number;
  readonly label: string;
  readonly version: number;
}

/**
 * The seams for the lost spots, one per gap however many notes pointed into
 * it. `olderDocs` holds the verified bytes of each version a lost note was
 * written against, parsed; `target` is the version on screen and
 * `targetVersion` its number, for the label. The version a seam opens is the
 * earliest its grouped notes still read on.
 */
export const seamsForLost = (
  lost: readonly LostSpot[],
  olderDocs: ReadonlyMap<number, Document>,
  target: Document,
  targetVersion: number,
): SeamSpec[] => {
  const byGap = new Map<number, { count: number; from: number }>();
  const targetBlocks = collectBlocks(target);
  for (const spot of lost) {
    const sel = spot.selectors;
    const older = olderDocs.get(spot.fromVersion);
    if (sel === undefined || older === undefined) continue;
    try {
      const found = older.querySelector(sel.css);
      if (found === null) continue;
      const oldBlocks = collectBlocks(older);
      const at = oldBlocks.findIndex((b) => b.el === found);
      if (at === -1) continue;
      const d = diffVersions(older, target);
      if (d.carried.has(at)) continue;
      // Where the first survivor after the removed block went.
      let survivor: number | undefined;
      for (const oldIndex of d.carried.keys()) {
        if (oldIndex > at && (survivor === undefined || oldIndex < survivor)) survivor = oldIndex;
      }
      const before =
        survivor === undefined ? targetBlocks.length : (d.carried.get(survivor) as number);
      const had = byGap.get(before);
      byGap.set(before, {
        count: (had?.count ?? 0) + 1,
        from: had === undefined ? spot.fromVersion : Math.min(had.from, spot.fromVersion),
      });
    } catch {
      // A seam is a convenience drawn from a diff; a document that will not
      // parse for this loses its seam and keeps its note.
    }
  }
  return [...byGap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([before, gap]) => ({
      before,
      label: `${gap.count} note${gap.count === 1 ? "" : "s"} pointed here · the passage is gone from v${targetVersion}`,
      version: gap.from,
    }));
};
