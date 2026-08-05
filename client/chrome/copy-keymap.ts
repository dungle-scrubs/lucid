import type { KeyChord } from "./keymap.ts";

/**
 * Copy redirection for the artifact surface, as a pure decision.
 *
 * Sibling of `keymap.ts`, and deliberate about what it is NOT. `keymap.ts`
 * answers "given this chord and these tabs, what should the SHELL do?" and
 * returns a value - open the palette, close a tab. This module answers a
 * narrower question that the shell's keymap does not own: "given this chord
 * and this focus state, should the artifact iframe be refocused so native
 * copy reaches it?" The two share `KeyChord` but not a decision, because copy
 * redirection is not a shortcut - it never swallows the event, so it returns a
 * boolean rather than a `Shortcut`. It only moves focus, and lets the
 * browser's own copy land on the document that actually holds the selection.
 *
 * Why it exists. In the default targeting mode, selecting text in the artifact
 * fires a `target-picked`, which auto-focuses the composer's note textarea in
 * the PARENT. The artifact's text stays visually selected, but focus has left
 * the opaque-origin iframe, so the browser's native copy targets the parent -
 * which has no selection - and copies nothing. The composer auto-focus is
 * intentional (pick a target, then type the note) and asserted by the loop
 * e2e, so the fix redirects the COPY, not the focus policy: when ⌘C/⌘C lands
 * on a chrome text field that holds no selection of its own, the wiring
 * refocuses the iframe and lets native copy run against it.
 *
 * The split exists for the same reason `keymap.ts`'s does (D-018): the
 * interesting part is the TABLE - which gesture, which focus state - and a
 * table is cheap to exhaustively test where a browser is expensive. The
 * DOM-reading (is the active element a text field, is the parent's selection
 * collapsed) is a thin wiring layer in `Chrome.tsx`, verified in e2e.
 */

/** The focus facts the decision reads. Named so a test can state them as data
 *  rather than touch the DOM; resolved in the wiring from `document.activeElement`
 *  (is it a text-entry field?) and that field's OWN selection (textarea/input
 *  selectionStart/End, contentEditable via the Selection API - the two are not
 *  the same API, so the wiring branches on the element type). */
export interface CopyFocusState {
  /** True when a chrome text-entry field (input/textarea/contentEditable) has
   *  focus. Copy redirection only undoes the composer auto-focus; with no text
   *  field focused, native copy already targets the right document. */
  readonly textEntryFocused: boolean;
  /** True when the parent's own selection is collapsed - i.e. the focused
   *  field has nothing selected of its own. A real in-field selection must be
   *  copied, never redirected. */
  readonly parentSelectionCollapsed: boolean;
}

/**
 * Should the chrome refocus the artifact iframe so native copy reaches it?
 *
 * The whole table: the gesture must be ⌘C or Ctrl+C (no Shift, no Alt), the
 * focus must be a chrome text-entry field, and that field must hold no
 * selection of its own. Every other combination is someone else's key.
 */
export const shouldRefocusArtifactOnCopy = (
  chord: KeyChord,
  focusState: CopyFocusState,
): boolean => {
  // The gesture: ⌘C or Ctrl+C, no Shift, no Alt. Shift and Alt make it a
  // different chord (⌘⇧C, ⌥⌘C) that the browser or OS may own, and a bare C
  // with no platform modifier is just typing.
  if (chord.altKey || chord.shiftKey) return false;
  if (!(chord.metaKey || chord.ctrlKey)) return false;
  if (chord.key !== "c" && chord.key !== "C") return false;
  // The focus: a chrome text-entry field that holds focus but has no selection
  // of its own. That is exactly the state the composer auto-focus produces
  // after a target pick - and the one where native copy would otherwise target
  // the parent and copy nothing.
  if (!focusState.textEntryFocused) return false;
  if (!focusState.parentSelectionCollapsed) return false;
  return true;
};
