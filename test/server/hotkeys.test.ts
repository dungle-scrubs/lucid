/**
 * The one hotkey, and the one place it stands down.
 *
 * Alt-Backspace flips between using the document and marking it up. It has
 * to reach the toggle from inside the frame too, so both sides ask the same
 * question — and both have to answer it the same way, or the key works in
 * half the window.
 */
import { describe, expect, test } from "bun:test";
import "../support/dom.js";
import { isModeToggle, togglesMode, writesProse } from "../../src/server/client/hotkeys.js";

const key = (over: Record<string, unknown> = {}) => ({
  key: "Backspace",
  altKey: true,
  ...over,
});

const el = (html: string, sel: string): Element => {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const found = d.querySelector(sel);
  if (found === null) throw new Error(`no ${sel}`);
  return found;
};

describe("recognising the mode toggle", () => {
  test("alt-backspace is the toggle", () => {
    expect(isModeToggle(key())).toBe(true);
  });

  test("backspace on its own is not", () => {
    // Otherwise deleting a character would flip the document out from under
    // whoever was typing.
    expect(isModeToggle(key({ altKey: false }))).toBe(false);
  });

  test("another key with alt held is not", () => {
    expect(isModeToggle(key({ key: "Delete" }))).toBe(false);
    expect(isModeToggle(key({ key: "a" }))).toBe(false);
  });

  test("a second modifier means something else", () => {
    // cmd-alt-backspace and ctrl-alt-backspace belong to the browser and the
    // operating system, and shift-alt-backspace is not this.
    expect(isModeToggle(key({ metaKey: true }))).toBe(false);
    expect(isModeToggle(key({ ctrlKey: true }))).toBe(false);
    expect(isModeToggle(key({ shiftKey: true }))).toBe(false);
  });
});

describe("where the key stands down", () => {
  test("inside the note box it deletes a word, as it always did", () => {
    const t = el('<div class="note-pop"><textarea></textarea></div>', "textarea");
    expect(writesProse(t)).toBe(true);
    expect(togglesMode(key(), t)).toBe(false);
  });

  test("inside the conversation composer, the same", () => {
    const t = el('<form class="composer"><textarea></textarea></form>', "textarea");
    expect(togglesMode(key(), t)).toBe(false);
  });

  test("in a field the agent wrote, it still toggles", () => {
    // The point of the key: a caret in the document, and one press to get
    // back to marking it up.
    const t = el('<form><input name="who" /></form>', "input");
    expect(writesProse(t)).toBe(false);
    expect(togglesMode(key(), t)).toBe(true);
  });

  test("with nothing focused it toggles", () => {
    expect(togglesMode(key(), null)).toBe(true);
    expect(togglesMode(key(), undefined)).toBe(true);
  });

  test("a target that cannot be asked is not treated as prose", () => {
    // The frame hands over whatever its event carried. Anything that is not
    // an element answers the same way as no element at all.
    expect(writesProse({})).toBe(false);
    expect(writesProse("textarea")).toBe(false);
    expect(togglesMode(key(), {})).toBe(true);
  });

  test("standing down is about the surface, not the key", () => {
    const t = el('<div class="note-pop"><textarea></textarea></div>', "textarea");
    // A press that was never the toggle is still not the toggle in there.
    expect(togglesMode(key({ altKey: false }), t)).toBe(false);
  });
});
