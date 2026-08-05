import { describe, expect, test } from "bun:test";
import type { KeyChord } from "../client/chrome/keymap.ts";
import { shouldRefocusArtifactOnCopy, type CopyFocusState } from "../client/chrome/copy-keymap.ts";

/**
 * The copy-redirection decision, as a table.
 *
 * `shouldRefocusArtifactOnCopy` answers one question: given this chord and
 * this focus state, should the chrome refocus the artifact iframe so the
 * browser's native copy reaches it? The answer is a value, not an effect -
 * the DOM-reading (which element has focus, whether the parent selection is
 * collapsed) lives in Chrome.tsx and is verified in e2e. What a browser is
 * the wrong instrument for is the TABLE: every awkward combination - a stray
 * Alt, a Shift held, a C with no modifier, an in-field selection a user
 * expects to copy - costs a function call here and a full shell run there.
 *
 * This mirrors `keymap.test.ts` (D-018): a scenario that never touches paint
 * does not need a browser. What did NOT move: that the handler is wired up,
 * and that ⌘C really refocuses the iframe a human is looking at. Those stay
 * in e2e.
 */

const chord = (over: Partial<KeyChord> = {}): KeyChord => ({
  key: "c",
  code: "KeyC",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

const focus = (over: Partial<CopyFocusState> = {}): CopyFocusState => ({
  textEntryFocused: true,
  parentSelectionCollapsed: true,
  ...over,
});

describe("the gesture a composer steals focus from", () => {
  test("Cmd+C redirects when a text field holds focus with no own selection", () => {
    // THE case this exists for: a target pick auto-focused the composer note,
    // the artifact's text is still visually selected, and native copy would
    // otherwise target the parent and copy nothing.
    expect(shouldRefocusArtifactOnCopy(chord(), focus())).toBe(true);
  });

  test("Ctrl+C redirects on the platform that uses Ctrl as its modifier", () => {
    // The shell treats Ctrl as the platform modifier alongside Cmd (see
    // keymap.ts): the redirect mirrors that, so a Windows/Linux human gets the
    // same recovery.
    expect(shouldRefocusArtifactOnCopy(chord({ metaKey: false, ctrlKey: true }), focus())).toBe(
      true,
    );
  });

  test("both modifiers at once still redirects (a held Cmd does not disqualify Ctrl)", () => {
    expect(shouldRefocusArtifactOnCopy(chord({ metaKey: true, ctrlKey: true }), focus())).toBe(
      true,
    );
  });
});

describe("a real in-field copy is never redirected", () => {
  test("the composer's own selection is copied, not the artifact's", () => {
    // The parent-selection guard: a user selecting text inside the annotation
    // note to copy it must not have their selection yanked away. Redirecting
    // here would copy the artifact's stale selection instead of what they just
    // highlighted.
    expect(shouldRefocusArtifactOnCopy(chord(), focus({ parentSelectionCollapsed: false }))).toBe(
      false,
    );
  });

  test("a non-text element holding focus is left alone", () => {
    // Copy redirection only undoes the composer auto-focus. With no text-entry
    // field focused (the iframe itself, a button), there is nothing stealing
    // focus FROM and native copy already targets the right document.
    expect(shouldRefocusArtifactOnCopy(chord(), focus({ textEntryFocused: false }))).toBe(false);
  });
});

describe("modifier and key disqualifications", () => {
  test("a bare C with no platform modifier is not ours", () => {
    // Someone is typing the letter c. Redirecting focus on every keystroke
    // would yank the caret out of the composer mid-sentence.
    expect(shouldRefocusArtifactOnCopy(chord({ metaKey: false, ctrlKey: false }), focus())).toBe(
      false,
    );
  });

  test("Alt held is a different gesture - ⌥⌘C is not ours", () => {
    // The OS or another app may own ⌥⌘C. Swallowing (or redirecting focus
    // during) it would steal a chord that is not ours.
    expect(shouldRefocusArtifactOnCopy(chord({ altKey: true }), focus())).toBe(false);
  });

  test("Shift held is a different gesture - ⌘⇧C is not ours", () => {
    expect(shouldRefocusArtifactOnCopy(chord({ shiftKey: true }), focus())).toBe(false);
  });

  test("a key other than c/C is not ours", () => {
    // ⌘V (paste), ⌘X (cut), ⌘A (select-all) are real gestures that must not
    // refocus the iframe.
    expect(shouldRefocusArtifactOnCopy(chord({ key: "v", code: "KeyV" }), focus())).toBe(false);
    expect(shouldRefocusArtifactOnCopy(chord({ key: "V", code: "KeyV" }), focus())).toBe(false);
    expect(shouldRefocusArtifactOnCopy(chord({ key: "x", code: "KeyX" }), focus())).toBe(false);
  });
});
