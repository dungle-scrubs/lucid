import { detectAnnotationBatch, filesOf, textWithoutAnnotations } from "./annotations.js";

const words = new Intl.Segmenter("en", { granularity: "word" });
export const CONVERSATION_TITLE_WORDS = 7;
export const CONVERSATION_TITLE_CHARACTERS = 128;
const invalidText = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Shared by manual validation, generated results, and the browser count. */
export function measureConversationTitle(value: string): {
  readonly characters: number;
  readonly title: string;
  readonly valid: boolean;
  readonly wordCount: number;
} {
  const title = value.trim().replace(/\s+/g, " ");
  const wordCount = [...words.segment(title)].filter((part) => part.isWordLike).length;
  const characters = [...title].length;
  return {
    characters,
    title,
    valid:
      !invalidText.test(value.trim()) &&
      wordCount > 0 &&
      wordCount <= CONVERSATION_TITLE_WORDS &&
      characters <= CONVERSATION_TITLE_CHARACTERS,
    wordCount,
  };
}

export const storedConversationTitle = (saved?: string): string | undefined => {
  if (saved === undefined) return undefined;
  const result = measureConversationTitle(saved);
  return result.valid ? result.title : undefined;
};

export const conversationTitle = (prompt: string, saved?: string): string => {
  const title = storedConversationTitle(saved);
  if (title !== undefined) return title;
  const normalized = prompt
    .replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  let end = 0;
  let count = 0;
  for (const part of words.segment(normalized)) {
    if (!part.isWordLike) continue;
    const next = part.index + part.segment.length;
    if (
      ++count > CONVERSATION_TITLE_WORDS ||
      [...normalized.slice(0, next)].length > CONVERSATION_TITLE_CHARACTERS
    )
      break;
    end = next;
  }
  return normalized.slice(0, end).trim() || "New conversation";
};

export type NamingInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "attachment" | "empty" };

/** Strip transport and file references. Attached contents are never a naming source. */
export function namingInput(text: string): NamingInput {
  const batch = detectAnnotationBatch(text);
  if (batch && !("malformed" in batch)) {
    const words =
      textWithoutAnnotations(text).trim() ||
      batch.notes.find((note) => note.note.trim())?.note.trim();
    if (words) return { kind: "text", text: words };
    if (batch.notes.some((note) => filesOf(note).length > 0)) return { kind: "attachment" };
    return { kind: "empty" };
  }
  return text.trim() ? { kind: "text", text } : { kind: "empty" };
}
export function namingPrompt(text: string): string {
  const input = namingInput(text);
  return input.kind === "text"
    ? input.text
    : input.kind === "attachment"
      ? "Attachment conversation"
      : "New conversation";
}

/** Validate stored title fields once for discovery and detail projections. */
export function savedTitleFields(value: Readonly<Record<string, unknown>>): {
  conversationTitle?: string;
  titleRevision?: number;
  titleOrigin?: "fallback" | "generated" | "manual";
} {
  return {
    ...(typeof value.conversationTitle === "string"
      ? { conversationTitle: value.conversationTitle }
      : {}),
    ...(Number.isSafeInteger(value.titleRevision) && Number(value.titleRevision) >= 0
      ? { titleRevision: Number(value.titleRevision) }
      : {}),
    ...(value.titleOrigin === "fallback" ||
    value.titleOrigin === "generated" ||
    value.titleOrigin === "manual"
      ? { titleOrigin: value.titleOrigin }
      : {}),
  };
}
export function titleState(value: Parameters<typeof savedTitleFields>[0]) {
  const saved = savedTitleFields(value);
  return {
    titleRevision: saved.titleRevision ?? 0,
    titleOrigin:
      saved.titleOrigin ??
      (storedConversationTitle(saved.conversationTitle)
        ? ("manual" as const)
        : ("fallback" as const)),
  };
}

export function fallbackConversationTitle(inputs: Iterable<{ readonly text: string }>): string {
  let fallback = "New conversation";
  for (const input of inputs) {
    const naming = namingInput(input.text);
    if (naming.kind === "text") return conversationTitle(naming.text);
    if (naming.kind === "attachment") fallback = namingPrompt(input.text);
  }
  return fallback;
}
