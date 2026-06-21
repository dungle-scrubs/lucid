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
