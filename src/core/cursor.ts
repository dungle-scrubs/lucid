/**
 * Cursor representation (D-040, D-050). The cursor IS the per-event `seq`,
 * rendered zero-padded as `evt_00042`. It is caller-owned and globally
 * monotonic across all lifecycle segments, so a persisted cursor stays valid
 * across an `end`-then-reopen.
 */

const PAD = 5;

/** Render a seq as a cursor string, e.g. 42 -> `evt_00042`. */
export const renderCursor = (seq: number): string => `evt_${String(seq).padStart(PAD, "0")}`;

/**
 * Parse a caller-supplied cursor into a seq. Accepts `evt_00042` or a bare
 * integer string. Returns `undefined` for an unparseable cursor (treated as
 * "from the beginning"); 0 means "before the first event".
 */
export const parseCursor = (input: string | undefined): number | undefined => {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const match = /^evt_(\d+)$/.exec(trimmed);
  if (match?.[1] !== undefined) {
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * The records a cursor still owes its caller: everything strictly after it.
 *
 * Strictly `>`, never `>=`. The cursor names the last event the caller has
 * ALREADY been handed, so `>=` would redeliver that one on every poll and an
 * agent looping on `nextCursor` would re-apply the same annotation forever.
 *
 * An absent cursor is the bootstrap read (D-056), not "cursor zero": nothing
 * has been seen, so everything is owed. Cursor `0` reaches the same set by a
 * different route - it is a delta from before the first event.
 *
 * Owns the arithmetic only. Which list is sliced, and what a caller does with
 * the result, stay with `wait`.
 */
export const sliceAfterCursor = <T extends { readonly seq: number }>(
  items: readonly T[],
  cursor: number | undefined,
): readonly T[] => (cursor === undefined ? items : items.filter((i) => i.seq > cursor));
