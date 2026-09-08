/**
 * A line-oriented difference between two versions' stored bytes.
 *
 * Deliberately **not** the block comparison in `version-diff.ts`, and the two
 * are not interchangeable. That one answers *what changed in the document you
 * read*: it parses, it works in blocks, and it treats a reflowed paragraph or
 * a reordered attribute as no change at all, because to a reader it is none.
 *
 * This one answers *what changed in the record*. The bytes are what lucid
 * stores and what the agent reads, so a difference over them can hide
 * nothing. A parse would: it needs a tree that a malformed document may not
 * give, and it would silently drop a change that alters the bytes without
 * altering the rendering. RFC-07 R9 chose this on purpose.
 *
 * ## The bound
 *
 * An artifact may be 1 MB, which is tens of thousands of lines, and the
 * ordinary way to line up two sequences costs their product. That is fine for
 * a revision and impossible for two unrelated documents.
 *
 * So: trim what matches at each end first, which is nearly everything when
 * one version was edited from the other, then line up the middle only if the
 * middle is small enough to afford. When it is not, the middle is reported as
 * one block replaced by another and `coarse` says so. A comparison that
 * quietly did something cheaper would be worse than one that admits it.
 */

/** The most cells the line-up may cost. Two thousand changed lines against
 * two thousand others, which no revision reaches and no reader would read.
 * Past it the answer is still true, just less finely divided. */
export const LINE_UP_CELLS_MAX = 4_000_000;

export type RowKind = "same" | "added" | "removed" | "changed";

export interface Row {
  readonly kind: RowKind;
  /** The line as it was. Absent on `added`. */
  readonly before?: string;
  /** The line as it now is. Absent on `removed`. */
  readonly after?: string;
  /** Line number in the earlier version, counted from 1. Absent on `added`. */
  readonly beforeNo?: number;
  /** Line number in the later version, counted from 1. Absent on `removed`. */
  readonly afterNo?: number;
}

export interface LineDiff {
  readonly rows: readonly Row[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  /** True when the middle was too large to line up and is reported as one
   * replacement rather than line by line. */
  readonly coarse: boolean;
  readonly identical: boolean;
}

/** Split on newlines, keeping every line including empty ones.
 *
 * `\r\n` is normalised because a line that differs only by how its ending was
 * written is not a change anyone means, and an agent and a person may not
 * agree on it. */
const lines = (s: string): string[] => s.replace(/\r\n?/g, "\n").split("\n");

/**
 * Compare two versions, line by line.
 *
 * Total: any two strings produce an answer. Two documents with nothing in
 * common report one wholly removed and the other wholly added.
 */
export const diffLines = (before: string, after: string): LineDiff => {
  const a = lines(before);
  const b = lines(after);

  // What matches at the top, then at the bottom. For a revision this is
  // almost the whole document, and it is what keeps the line-up affordable.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const rows: Row[] = [];
  const push = (r: Row): void => {
    rows.push(r);
  };
  for (let i = 0; i < head; i += 1) {
    push({
      kind: "same",
      before: a[i] as string,
      after: b[i] as string,
      beforeNo: i + 1,
      afterNo: i + 1,
    });
  }

  let added = 0;
  let removed = 0;
  let coarse = false;

  if (midA.length === 0 && midB.length === 0) {
    // Nothing between the ends.
  } else if (midA.length * midB.length > LINE_UP_CELLS_MAX) {
    coarse = true;
    for (let i = 0; i < midA.length; i += 1) {
      push({ kind: "removed", before: midA[i] as string, beforeNo: head + i + 1 });
      removed += 1;
    }
    for (let i = 0; i < midB.length; i += 1) {
      push({ kind: "added", after: midB[i] as string, afterNo: head + i + 1 });
      added += 1;
    }
  } else {
    // Longest common subsequence over the middle, then walked back into rows.
    // The table is (n+1) x (m+1) counts; `midA.length * midB.length` above is
    // what bounds it.
    const n = midA.length;
    const m = midB.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      const rowI = lcs[i] as number[];
      const rowNext = lcs[i + 1] as number[];
      for (let j = m - 1; j >= 0; j -= 1) {
        rowI[j] =
          midA[i] === midB[j]
            ? (rowNext[j + 1] as number) + 1
            : Math.max(rowNext[j] as number, rowI[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push({
          kind: "same",
          before: midA[i] as string,
          after: midB[j] as string,
          beforeNo: head + i + 1,
          afterNo: head + j + 1,
        });
        i += 1;
        j += 1;
      } else if ((lcs[i + 1]?.[j] as number) >= (lcs[i]?.[j + 1] as number)) {
        push({ kind: "removed", before: midA[i] as string, beforeNo: head + i + 1 });
        removed += 1;
        i += 1;
      } else {
        push({ kind: "added", after: midB[j] as string, afterNo: head + j + 1 });
        added += 1;
        j += 1;
      }
    }
    while (i < n) {
      push({ kind: "removed", before: midA[i] as string, beforeNo: head + i + 1 });
      removed += 1;
      i += 1;
    }
    while (j < m) {
      push({ kind: "added", after: midB[j] as string, afterNo: head + j + 1 });
      added += 1;
      j += 1;
    }
  }

  for (let k = 0; k < tail; k += 1) {
    const ai = a.length - tail + k;
    const bi = b.length - tail + k;
    push({
      kind: "same",
      before: a[ai] as string,
      after: b[bi] as string,
      beforeNo: ai + 1,
      afterNo: bi + 1,
    });
  }

  // A run of removals followed by a run of additions is a rewrite, and the
  // two runs are paired position by position.
  //
  // Pairing only at the seam - the last removal with the first addition -
  // was the first attempt and is wrong for anything longer than one line: a
  // three-line paragraph rewritten came back as one change, two orphaned
  // deletions and two orphaned insertions. Side by side that leaves each
  // column half empty against rows that plainly correspond.
  //
  // Whatever is left over when one run is longer stays what it was.
  const paired: Row[] = [];
  for (let k = 0; k < rows.length; ) {
    let cut = k;
    while (cut < rows.length && (rows[cut] as Row).kind === "removed") cut += 1;
    let end = cut;
    while (end < rows.length && (rows[end] as Row).kind === "added") end += 1;
    const gone = rows.slice(k, cut);
    const came = rows.slice(cut, end);
    if (gone.length === 0 || came.length === 0) {
      paired.push(rows[k] as Row);
      k += 1;
      continue;
    }
    const both = Math.min(gone.length, came.length);
    for (let t = 0; t < both; t += 1) {
      const g = gone[t] as Row;
      const c = came[t] as Row;
      paired.push({
        kind: "changed",
        before: g.before as string,
        after: c.after as string,
        beforeNo: g.beforeNo as number,
        afterNo: c.afterNo as number,
      });
    }
    for (let t = both; t < gone.length; t += 1) paired.push(gone[t] as Row);
    for (let t = both; t < came.length; t += 1) paired.push(came[t] as Row);
    k = end;
  }
  const changed = paired.filter((r) => r.kind === "changed").length;

  return {
    rows: paired,
    added: added - changed,
    removed: removed - changed,
    changed,
    coarse,
    identical: changed === 0 && added === 0 && removed === 0,
  };
};
