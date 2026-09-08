import { expect, test } from "bun:test";
import {
  conversationTitle,
  storedConversationTitle,
} from "../../src/protocol/conversation-title.js";

test("title validation enforces plain single-line Unicode text after space normalization", () => {
  expect(storedConversationTitle("Short\u2028title")).toBeUndefined();
  expect(storedConversationTitle("Broken\ud800title")).toBeUndefined();
  expect(storedConversationTitle(`  ${"é".repeat(128)}  `)).toBe("é".repeat(128));
  expect(storedConversationTitle("one two three four five six seven eight")).toBeUndefined();
  expect(storedConversationTitle("   A   useful   title  ")).toBe("A useful title");
  expect(conversationTitle("one two three four five six seven eight")).toBe(
    "one two three four five six seven",
  );
});

test("surrounding whitespace is normalized but interior control characters refuse", () => {
  expect(storedConversationTitle("\n Useful title\t\r\n")).toBe("Useful title");
  expect(storedConversationTitle("Useful\ntitle")).toBeUndefined();
  expect(storedConversationTitle("Useful\ttitle")).toBeUndefined();
});

test("an annotation envelope without text or files does not invent a naming prompt", async () => {
  const { encodeAnnotationBatch } = await import("../../src/protocol/annotations.js");
  const { namingInput, namingPrompt } = await import("../../src/protocol/conversation-title.js");
  const envelope = encodeAnnotationBatch({
    artifactId: "doc",
    version: 1,
    notes: [{ note: "", spots: [] }],
  });
  expect(namingInput(envelope)).toEqual({ kind: "empty" });
  expect(namingPrompt(envelope)).toBe("New conversation");
});
