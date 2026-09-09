import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  conversationTitle,
  namingInput,
  namingPrompt,
  storedConversationTitle,
} from "../protocol/conversation-title.js";
import { pathsForDir } from "./errors.js";

/** Read only through the first meaningful text; artifact history is not folded to name a row. */
export const readConversationTitle = async (dir: string, saved?: string): Promise<string> => {
  const title = storedConversationTitle(saved);
  if (title !== undefined) return title;
  const stream = createReadStream(pathsForDir(dir).logPath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let fallback = conversationTitle("");
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
      const input = namingInput(entry.input.text);
      if (input.kind === "text") return conversationTitle(input.text);
      if (input.kind === "attachment") fallback = namingPrompt(entry.input.text);
    }
    return fallback;
  } finally {
    lines.close();
    stream.destroy();
  }
};
