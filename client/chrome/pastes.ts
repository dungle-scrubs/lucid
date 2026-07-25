import type { ClipboardEvent } from "react";

/**
 * Large pastes collapse to a placeholder, the way terminal agents show them.
 *
 * A wall of text pasted into a two-row composer (a log, a diff, another
 * agent's transcript) floods the input and hides whatever was typed around
 * it. So past a size gate the composer shows `[Pasted text #1 +212 lines]`
 * instead, the full content is staged here, and send-time substitution puts
 * it back: the agent reads everything, the human reads their own message.
 *
 * Tab-local by design. The staged map lives in the session instance, not the
 * log - a reload before sending forgets the content along with the draft that
 * referenced it, and a placeholder edited into something else simply sends
 * as the text it became, exactly as typed. Per session, because two sessions'
 * composers must not expand each other's placeholders.
 */

/** Past either bound a paste stops being readable inline and folds. */
const MAX_INLINE_CHARS = 800;
const MAX_INLINE_LINES = 8;

/** Lines as a human counts them: a trailing newline ends the last line, it
 *  does not start an empty one. */
const countLines = (text: string): number => text.replace(/\n$/, "").split("\n").length;

export const isLargePaste = (text: string): boolean =>
  text.length > MAX_INLINE_CHARS || countLines(text) > MAX_INLINE_LINES;

export interface Pastes {
  /** Stage a paste and mint the placeholder that stands in for it. */
  readonly stagePaste: (text: string) => string;
  /** Substitute every staged placeholder back into `text`. Pure: entries are
   *  retired separately (consumePastes) once the send that used them lands, so
   *  a failed send can retry and expand to the same message. */
  readonly expandPastes: (text: string) => string;
  /** Retire the placeholders a sent text used, once the send landed. Without
   *  this, a LATER message that literally quotes an old placeholder would
   *  silently expand to the old paste - staged content must stand in for
   *  exactly one send, not haunt the rest of the session. Callers pass the
   *  pre-expansion text (the expanded one no longer contains the tokens). */
  readonly consumePastes: (text: string) => void;
  /**
   * The composer half: fold a large text paste into a placeholder at the
   * caret. Shared by every textarea that takes feedback text. Small pastes
   * fall through untouched, as do file pastes (their text/plain slot is
   * empty).
   */
  readonly collapseTextPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}

export const createPastes = (): Pastes => {
  const staged = new Map<string, string>();
  let counter = 0;

  const stagePaste = (text: string): string => {
    counter += 1;
    const placeholder = `[Pasted text #${counter} +${countLines(text)} lines]`;
    staged.set(placeholder, text);
    return placeholder;
  };

  const expandPastes = (text: string): string => {
    let out = text;
    for (const [placeholder, content] of staged) {
      // A function replacement: a string one would reinterpret `$&` and
      // friends inside the pasted content as substitution patterns.
      out = out.replaceAll(placeholder, () => content);
    }
    return out;
  };

  const consumePastes = (text: string): void => {
    for (const placeholder of staged.keys()) {
      if (text.includes(placeholder)) staged.delete(placeholder);
    }
  };

  const collapseTextPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = e.clipboardData.getData("text/plain");
    if (text.length === 0 || !isLargePaste(text)) return;
    // A mixed payload (files riding along with large text, e.g. a spreadsheet
    // selection) keeps the default path: preventDefault here would silently
    // drop the files the attachment pipeline was about to pick up.
    if (Array.from(e.clipboardData.items).some((i) => i.kind === "file")) return;
    e.preventDefault();
    const placeholder = stagePaste(text);
    // execCommand is deprecated, but it is still the one call that inserts at
    // the caret, fires the input event a React-controlled textarea listens
    // for, and keeps the undo stack. Engines that refuse it get the manual
    // splice.
    if (!document.execCommand("insertText", false, placeholder)) {
      const el = e.currentTarget;
      el.setRangeText(placeholder, el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  return { stagePaste, expandPastes, consumePastes, collapseTextPaste };
};
