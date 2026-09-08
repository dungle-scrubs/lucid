import { expect, test } from "bun:test";
import { conversationViewUrl, initialConversationPanel } from "../../src/server/view-options.js";

test("printed conversation URLs carry only the explicit view initializer", () => {
  expect(conversationViewUrl("http://127.0.0.1:17454", "release review")).toBe(
    "http://127.0.0.1:17454/c/release%20review",
  );
  for (const choice of ["open", "closed"] as const) {
    expect(conversationViewUrl("http://127.0.0.1:17454", "release review", choice)).toBe(
      `http://127.0.0.1:17454/c/release%20review?conversation-panel=${choice}`,
    );
  }
});

test("only a single explicit open parameter opens a new view", () => {
  expect(initialConversationPanel("?conversation-panel=open")).toBe(true);
  for (const search of [
    "",
    "?conversation-panel=closed",
    "?conversation-panel=bad",
    "?conversation-panel=OPEN",
    "?conversation-panel=open&conversation-panel=open",
    "?conversation-panel=closed&conversation-panel=open",
  ]) {
    expect(initialConversationPanel(search)).toBe(false);
  }
});
