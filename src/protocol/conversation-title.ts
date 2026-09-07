const words = new Intl.Segmenter("en", { granularity: "word" });

/** Read-only display fallback. Generation and manual writes have their own lifecycle. */
export const storedConversationTitle = (saved?: string): string | undefined => {
  if (saved && !/[\p{Cc}]/u.test(saved) && [...saved].length <= 128) {
    const count = [...words.segment(saved)].filter((part) => part.isWordLike).length;
    if (count > 0 && count <= 7) return saved.trim().replace(/\s+/g, " ");
  }
  return undefined;
};

export const conversationTitle = (prompt: string, saved?: string): string => {
  const title = storedConversationTitle(saved);
  if (title !== undefined) return title;
  const normalized = prompt
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  let end = 0;
  let count = 0;
  for (const part of words.segment(normalized)) {
    if (!part.isWordLike) continue;
    const next = part.index + part.segment.length;
    if (++count > 7 || [...normalized.slice(0, next)].length > 128) break;
    end = next;
  }
  return normalized.slice(0, end).trim() || "New conversation";
};
