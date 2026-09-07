import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { detectAnnotationBatch, textWithoutAnnotations } from "../protocol/annotations.js";
import { conversationTitle, storedConversationTitle } from "../protocol/conversation-title.js";
import { pathsForDir } from "./errors.js";

/** Read only through the first input; artifact history is not folded to name a row. */
export const readConversationTitle = async (dir: string, saved?: string): Promise<string> => {
  const title = storedConversationTitle(saved);
  if (title !== undefined) return title;
  const stream = createReadStream(pathsForDir(dir).logPath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || !("src" in entry) || entry.src !== "input")
        continue;
      if (
        !("input" in entry) ||
        !entry.input ||
        typeof entry.input !== "object" ||
        !("text" in entry.input) ||
        typeof entry.input.text !== "string"
      )
        throw new Error("Invalid input entry");
      const text = entry.input.text;
      const batch = detectAnnotationBatch(text);
      return conversationTitle(
        batch && !("malformed" in batch)
          ? textWithoutAnnotations(text) || batch.notes[0]?.note || "Annotation conversation"
          : text,
      );
    }
    return "New conversation";
  } finally {
    lines.close();
    stream.destroy();
  }
};
