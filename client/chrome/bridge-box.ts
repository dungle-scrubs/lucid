/**
 * bridgeBox - the pure geometry of the active-tab bridge (plan 04, M0.1).
 *
 * The active tab pours into the header below it as one continuous surface: the
 * bridge fills the moat under that one tab - its group frame's bottom border,
 * the row's padding, and the strip's own border-b - so no seam shows between
 * the tab and the header. This module owns ONLY that geometry. It takes two
 * rects and a boolean and returns a box; it never touches the DOM, which is
 * why the tab-strip effect's load-bearing math is unit-testable here instead
 * of only through an e2e.
 *
 * The bridge wears the tab's SIDE seams down to the header, so its box must
 * cover them. A tab's left hairline is its own `border-l` INSIDE its box,
 * except the group's first tab (`first:border-l-0`), whose left edge IS the
 * frame's border 1px OUTSIDE the box. The right seam - the next tab's
 * `border-l`, or the frame's `border-r` at the end of a group - is always 1px
 * outside. So the first tab gets +1 on left and +1 on width (both frame
 * borders); every other tab gets only the right-side +1.
 */

/** The slice of a `DOMRect` the bridge reads from each input. Structural, so a
 *  test passes a plain literal and a live `getBoundingClientRect()` satisfies
 *  the same shape. */
export interface BridgeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly bottom: number;
}

/** The bridge's box, in the strip's own coordinate frame. */
export interface BridgeBox {
  readonly left: number;
  readonly width: number;
  readonly top: number;
}

/**
 * Compute the active tab's bridge box.
 *
 * @param tab   the active tab's rect (viewport coordinates).
 * @param strip the outer strip's rect (viewport coordinates) - the frame the
 *              box is expressed in.
 * @param first whether the tab is the first in its group (the `first:border-l-0`
 *              case, whose left edge is the frame border 1px outside its box).
 */
export const bridgeBox = (tab: BridgeRect, strip: BridgeRect, first: boolean): BridgeBox => {
  const left = tab.left - strip.left - (first ? 1 : 0);
  return {
    left,
    width: tab.width + 1 + (first ? 1 : 0),
    top: tab.bottom - strip.top,
  };
};
