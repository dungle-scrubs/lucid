/**
 * The overlay's selection-offer decision, as a pure table.
 *
 * `shouldOfferSelectionCopy` answers ONE question: on mouseup, given the
 * targeting mode and whether the current selection is collapsed, should the
 * overlay post a `selection-copy` to the parent chrome? The answer is a value,
 * not an effect - the DOM-reading (window.getSelection, e.clientX/Y) lives in
 * `overlay.ts`'s `onMouseUp` and is verified in e2e. What a browser is the
 * wrong instrument for is the TABLE: every combination of mode and collapse
 * costs a function call here and a full e2e run there.
 *
 * Why it exists, and why it is mode-independent. Copying artifact text out is
 * a READ action; whether the surface also accepts annotation picks (targeting
 * ON, crosshair) has nothing to do with it. The pre-Popover overlay gated ALL
 * selection handling on `showTargets` and so offered a copy path in targeting
 * mode only. The Popover replaces that with a single, mode-independent copy
 * affordance (D-002), and THIS decision pins it: `showTargets` is intentionally
 * part of the input and intentionally never changes the result, so a future
 * re-introduction of the gate (`if (!showTargets) return false`) regresses the
 * unit test rather than silently dropping read-mode copy. Sibling of the
 * chrome-side `selection-copy.ts` (D-004): the decision lives where it is
 * consumed, i.e. in the overlay.
 *
 * Pure: no DOM globals.
 */

/** The facts the decision reads. Named so a test can state them as data rather
 *  than touch the DOM; the wiring resolves `showTargets` from the overlay's
 *  field and `selectionCollapsed` from `window.getSelection().isCollapsed`. */
export interface SelectionOfferInput {
  /** Read mode when false. Intentionally part of the contract so the
   *  mode-independence is explicit and testable; intentionally never gates the
   *  result. */
  readonly showTargets: boolean;
  /** True when the selection is collapsed (a bare click with no range). */
  readonly selectionCollapsed: boolean;
}

/**
 * Should the overlay post a `selection-copy` for this mouseup?
 *
 * The whole table: a non-collapsed selection offers a copy, a collapsed one
 * (a bare click) offers nothing, and `showTargets` is considered but never
 * changes the outcome - copy is offered in BOTH targeting modes.
 */
export const shouldOfferSelectionCopy = ({
  showTargets,
  selectionCollapsed,
}: SelectionOfferInput): boolean => {
  // Copying is a read action. `showTargets` is deliberately read here and
  // deliberately never gates the result: pinning the mode-independence means a
  // future regression (re-gating on showTargets, as the pre-Popover overlay
  // did) fails this unit test instead of silently dropping read-mode copy.
  void showTargets;
  return !selectionCollapsed;
};
