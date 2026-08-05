/**
 * The copy Popover's pure coordinate math.
 *
 * Sibling of `keymap.ts` (and the reverted `copy-keymap.ts`): the interesting
 * part of the Popover's anchoring is the COORDINATE TRANSLATION, and that is a
 * couple of additions a browser is the wrong instrument for measuring. The
 * split is the same one (D-018): a function that never touches paint does not
 * need a browser, so hoisting it out of the React wiring makes the table cheap
 * to exhaustively cover and leaves the DOM-reading (which iframe, what rect)
 * as a thin layer verified in e2e.
 *
 * Why it exists. The artifact iframe runs on an opaque origin
 * (`sandbox="allow-scripts"`, no `allow-same-origin`), so the parent chrome
 * cannot read its selection or its live DOM. The overlay - which CAN read
 * both, because it lives inside that frame - posts the selection text plus the
 * release point in IFRAME-viewport coordinates. The Popover renders in the
 * PARENT, so those coordinates must be translated by the iframe's bounding
 * rect before they anchor anything. This module owns that translation (and,
 * later, the dismissal state machine); the DOM touch - reading
 * `iframe.getBoundingClientRect()` - stays in the wiring.
 *
 * Pure: no DOM globals. `ViewportOrigin` is the slice of `DOMRect` the math
 * reads (`left`, `top`), named so a test can state a position as data rather
 * than construct a real `DOMRect`; production passes the iframe's live rect.
 */

/** The parent-viewport origin the translation reads. A `DOMRect` from
 *  `iframe.getBoundingClientRect()` satisfies this, but naming the minimal
 *  slice keeps the helper pure over values - a test passes `{ left, top }`. */
export interface ViewportOrigin {
  readonly left: number;
  readonly top: number;
}

/** The rect the Popover anchors against at the selection-release point. A
 *  zero-size rect (the release point itself) in practice; the fields are the
 *  ones Base UI's VirtualElement getBoundingClientRect returns, so a live
 *  `DOMRect` satisfies this and a constructed plain object does too. Named
 *  locally rather than reusing the DOM-global `DOMRect` type so the reducer is
 *  pure over values and a test never constructs a browser object. */
export interface CopyPopoverAnchor {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
  readonly x: number;
  readonly y: number;
}

/** The Popover's open state: the selected text (written to the clipboard on a
 *  copy click) and the rect it anchors at. Null = dismissed. */
export type CopyPopoverState = {
  readonly text: string;
  readonly anchorRect: CopyPopoverAnchor;
} | null;

/** The events the wiring dispatches into the reducer. A `selection-copy`
 *  opens (or re-anchors); everything else either copies-and-closes or
 *  dismisses. */
export type CopyPopoverEvent =
  | {
      readonly kind: "selection-copy";
      readonly text: string;
      readonly anchorRect: CopyPopoverAnchor;
    }
  | { readonly kind: "copy-click" }
  | { readonly kind: "click-away" }
  | { readonly kind: "scroll" }
  | { readonly kind: "collapse" }
  | { readonly kind: "geometry-change" }
  | { readonly kind: "mode-toggle" }
  | { readonly kind: "swap" };

/** The events that dismiss an open Popover. Enumerated as a set rather than a
 *  switch arm per kind so the table reads as a table: copy-click closes too,
 *  but it is the SUCCESS close (after the clipboard write), not a dismissal,
 *  so it stays its own arm. */
const DISMISSAL_EVENTS = new Set<CopyPopoverEvent["kind"]>([
  "click-away",
  "scroll",
  "collapse",
  "geometry-change",
  "mode-toggle",
  "swap",
]);

/**
 * The copy Popover's dismissal state machine.
 *
 * A pure reducer: `selection-copy` opens (or, when already open, REPLACES so
 * two Popovers never stack); `copy-click` and every dismissal event closes.
 * Every event against an idle (null) state is a no-op. The DOM/React wiring
 * dispatches these events from real sources (Base UI outside-click, scroll,
 * `setOutlineGeometryMoving`, the `showTargets` toggle, an artifact swap);
 * this reducer owns ONLY the transition table, so the lifecycle is cheap to
 * exhaustively test where a browser is expensive (D-004, D-018). Pure: no DOM
 * globals referenced.
 */
export const nextCopyPopoverState = (
  state: CopyPopoverState,
  event: CopyPopoverEvent,
): CopyPopoverState => {
  if (event.kind === "selection-copy") {
    return { text: event.text, anchorRect: event.anchorRect };
  }
  // copy-click and every dismissal event close an open Popover; against an
  // idle state every one of them is a no-op (the `state ?? null` fall-through).
  if (state === null) return null;
  if (event.kind === "copy-click" || DISMISSAL_EVENTS.has(event.kind)) return null;
  return state;
};

/**
 * Translate an in-iframe release point to parent-viewport coordinates.
 *
 * The overlay posts `clientX`/`clientY` from its own `mouseup`, which are
 * relative to the iframe's viewport. The Popover renders in the parent, so it
 * anchors at that point PLUS the iframe's top-left corner in the parent
 * viewport. The caller guarantees finite inputs (the validator refuses
 * non-finite coords at the boundary; the rect comes from a live measurement).
 */
export const translateToViewport = (
  rect: ViewportOrigin,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } => ({ x: rect.left + x, y: rect.top + y });
