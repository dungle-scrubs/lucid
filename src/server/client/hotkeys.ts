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
