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

/**
 * Alt-Backspace: switch between using the document and marking it up.
 *
 * It fires wherever it is pressed, including in a text box, where the
 * browser would otherwise delete the word behind the caret. That is the
 * trade, and it is deliberate: the key is worth more than delete-word-back.
 *
 * One consequence, the same one Escape has: pressing it while writing a
 * note ends that note. Use mode has no selection for a note to point at, so
 * there is nothing to come back to.
 */
export const isModeToggle = (e: KeyLike): boolean =>
  e.altKey === true &&
  e.key === "Backspace" &&
  e.ctrlKey !== true &&
  e.metaKey !== true &&
  e.shiftKey !== true;

/**
 * Command-Enter, or control-Enter: send what is queued.
 *
 * The same key that adds a note to the queue sends the queue once no note
 * is being written. Adding one and sending them is the same gesture twice,
 * which is what a person does anyway — the second press had no meaning
 * before, so nothing is taken away by giving it one.
 *
 * Whether anything is queued, and whether a note box is open, is not asked
 * here. Only the page knows either, and the frame has to be able to ask the
 * same question without knowing either one.
 */
export const isQueueSend = (e: KeyLike): boolean =>
  e.key === "Enter" &&
  (e.metaKey === true || e.ctrlKey === true) &&
  e.altKey !== true &&
  e.shiftKey !== true;
