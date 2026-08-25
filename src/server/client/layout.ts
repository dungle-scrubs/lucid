/**
 * How wide the conversation is, and remembering it.
 *
 * The split was fixed, so a long document and a long conversation could not
 * both be read on the same screen. It is dragged now, and where it is left
 * is where it is next time.
 */

/** Narrow enough to be a margin, wide enough to read a paragraph in. */
export const CONVERSATION_MIN = 280;
export const CONVERSATION_MAX = 900;

/** The document keeps at least this much, whatever the conversation asks
 * for. A pane dragged to nothing cannot be dragged back. */
export const DOCUMENT_MIN = 320;

export const STORAGE_KEY = "lucid.conversationWidth";

/** What the conversation may actually be, in a window this wide. */
export const clampConversationWidth = (want: number, windowWidth: number): number => {
  if (!Number.isFinite(want)) return CONVERSATION_MIN;
  const room = windowWidth - DOCUMENT_MIN;
  const top = Math.min(CONVERSATION_MAX, Math.max(CONVERSATION_MIN, room));
  return Math.round(Math.min(top, Math.max(CONVERSATION_MIN, want)));
};

/** What was left last time, or nothing. Reading storage throws in a private
 * window and in a browser set to refuse site data, and a width is not worth
 * a blank page. */
export const readConversationWidth = (store: Pick<Storage, "getItem"> | null): number | null => {
  try {
    const raw = store?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

export const writeConversationWidth = (
  store: Pick<Storage, "setItem"> | null,
  width: number,
): void => {
  try {
    store?.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Nothing depends on it having been written.
  }
};
