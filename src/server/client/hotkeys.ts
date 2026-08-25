/**
 * Keys that mean the same thing wherever they are pressed.
 *
 * There is one, and it is the mode toggle. It has to work from inside the
 * document as well as outside it, and the document is a sandboxed frame with
 * its own keyboard — so this is the shared answer to "was that the toggle",
 * asked once in the page and once in the frame.
 */

/** Only the fields of a keyboard event this needs, so the frame can ask the
 * question with a plain object and a test does not have to build one. */
export interface KeyLike {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Alt-Backspace: switch between using the document and marking it up. */
export const isModeToggle = (e: KeyLike): boolean =>
  e.altKey === true &&
  e.key === "Backspace" &&
  e.ctrlKey !== true &&
  e.metaKey !== true &&
  e.shiftKey !== true;

/**
 * lucid's own writing surfaces. In these, alt-backspace already means delete
 * the word behind the caret, and taking that away from someone mid-sentence
 * is worse than making them reach for the mode buttons.
 *
 * The document's own fields are not on this list. Flipping to mark-up mode
 * with a caret sitting in a field the agent wrote is the whole reason the
 * key exists, and a field in a checklist is not where prose gets written.
 */
export const WRITING_SURFACES = ".note-pop, .composer";

export const writesProse = (target: unknown): boolean => {
  const el = target as { closest?: (selectors: string) => unknown } | null | undefined;
  if (el === null || el === undefined || typeof el.closest !== "function") return false;
  return el.closest(WRITING_SURFACES) !== null;
};

/** True when this key press should flip the mode. */
export const togglesMode = (e: KeyLike, target: unknown): boolean =>
  isModeToggle(e) && !writesProse(target);
