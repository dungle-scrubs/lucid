/**
 * The one badge-numbering function (M4.1): a card in the panel and its badge on
 * the overlay must wear the SAME number for the click-to-jump to land. The
 * timeline (buildTimeline) and the marker pipeline (computeMarkers) each used
 * to count independently, and the two drifted on the orphan edge - an
 * unresolved annotation has no mark, so it must advance no number, and counting
 * it anyway shifted every later badge off its card.
 *
 * The rule: resolved annotations number 1, 2, 3... in record order (orphans
 * skipped), then queued annotations CONTINUE the count (a queued note is the
 * next number, not a second number 1). A queued id that already resolved keeps
 * its resolved number, so the brief window where an id is in both lists cannot
 * produce two numbers for one record.
 */

/** The id shapes the numbering reads - both a panel annotation and an overlay
 *  committed source carry an `id`; `resolved` is the orphan gate. */
interface Numbered {
  readonly id: string;
  readonly resolved: boolean;
}

/**
 * Assign 1-based numbers to annotation ids. Resolved annotations number in
 * record order; unresolved (orphan) annotations are skipped (they advance no
 * number). Queued ids continue the resolved count; a queued id that already
 * resolved keeps the number it already has.
 */
export const numberAnnotations = (
  annotations: readonly Numbered[],
  queued: readonly { readonly id: string }[],
): ReadonlyMap<string, number> => {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const a of annotations) {
    if (!a.resolved) continue; // orphan: no mark, no number
    n += 1;
    numbers.set(a.id, n);
  }
  queued.forEach((q) => {
    if (!numbers.has(q.id)) {
      n += 1;
      numbers.set(q.id, n);
    }
  });
  return numbers;
};
