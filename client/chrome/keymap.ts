/**
 * The shell's keyboard map, as a pure decision.
 *
 * `resolveShortcut` answers ONE question - given this key event and this tab
 * state, what should happen? - and answers it with a value rather than an
 * effect. Everything about the gesture lives here; everything about carrying
 * it out lives in the caller.
 *
 * The split exists because the interesting part of a keyboard map is its
 * TABLE, and a table is exactly what a browser is the wrong instrument for
 * measuring. Asking "does ⌥⌘K open the palette?" through a real shell costs a
 * hub, a session, a page load and a settle; asking it here costs a function
 * call, so the awkward combinations that actually break - a modifier too many,
 * a digit past the end of the strip, a bracket step with one tab - get
 * covered because covering them is cheap. What the browser is still the right
 * instrument for is that the map is WIRED UP at all, and that ⌘1 really lands
 * on the tab a human sees; those stay in e2e.
 *
 * `keys` is the VISIBLE, project-scoped strip, because that is what the
 * pointer indexes and the keyboard must agree with it.
 */

/** What the shell should do about a key press. `none` means "not ours" - the
 *  event is left alone, which is different from "ours, and it did nothing". */
export type Shortcut =
  | { readonly kind: "none" }
  | { readonly kind: "palette" }
  | { readonly kind: "close"; readonly key: string }
  | { readonly kind: "activate"; readonly key: string };

/** The parts of a KeyboardEvent the map reads. Named so a test can state a
 *  combination as data rather than construct a DOM event for it. */
export interface KeyChord {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export interface TabState {
  /** The visible, project-scoped strip, in display order. */
  readonly keys: readonly string[];
  /** The tab in front, or null when the pick screen is showing. */
  readonly activeKey: string | null;
}

export const resolveShortcut = (chord: KeyChord, state: TabState): Shortcut => {
  // A platform modifier is required, and ALT disqualifies: ⌥⌘K is a different
  // gesture from ⌘K, and swallowing it would eat a chord the OS or another
  // app may own.
  if (!(chord.metaKey || chord.ctrlKey) || chord.altKey) return { kind: "none" };

  if (!chord.shiftKey && (chord.key === "k" || chord.key === "K")) return { kind: "palette" };

  // ⌘W closes the ARTIFACT in front of you - what the gesture means in a
  // tabbed window. With nothing in front, it is not ours to swallow.
  if (!chord.shiftKey && (chord.key === "w" || chord.key === "W")) {
    return state.activeKey === null ? { kind: "none" } : { kind: "close", key: state.activeKey };
  }

  const digit = Number.parseInt(chord.key, 10);
  if (!chord.shiftKey && Number.isInteger(digit) && digit >= 1 && digit <= 9) {
    const key = state.keys[digit - 1];
    // ⌘5 with two tabs indexes past the end. Nothing happens, and nothing is
    // swallowed either - a preventDefault here would silently eat a chord the
    // browser might have used.
    return key ? { kind: "activate", key } : { kind: "none" };
  }

  if (chord.shiftKey && (chord.code === "BracketLeft" || chord.code === "BracketRight")) {
    // Stepping needs somewhere to step from and somewhere to go: one tab
    // wraps to itself, which is a no-op worth not pretending about.
    if (state.keys.length < 2 || state.activeKey === null) return { kind: "none" };
    const at = state.keys.indexOf(state.activeKey);
    // An active tab outside the visible strip (it belongs to another project)
    // has no position to step from - `indexOf` answers -1, and stepping from
    // -1 would land on an arbitrary neighbour.
    if (at < 0) return { kind: "none" };
    const step = chord.code === "BracketRight" ? 1 : -1;
    const next = state.keys[(at + step + state.keys.length) % state.keys.length];
    return next ? { kind: "activate", key: next } : { kind: "none" };
  }

  return { kind: "none" };
};
