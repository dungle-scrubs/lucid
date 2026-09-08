/**
 * The split between the document and the conversation.
 *
 * Two things it must never do: let either pane be dragged to a width you
 * cannot drag back from, and lose the page because the browser refused to
 * hand over site data.
 */
import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_MAX,
  CONVERSATION_MIN,
  clampConversationWidth,
  clampDocumentShare,
  DOCUMENT_MIN,
  readConversationWidth,
  STORAGE_KEY,
  writeConversationWidth,
} from "../../src/server/client/layout.js";

const WIDE = 1600;

describe("how wide the conversation may be", () => {
  test("a width in range is kept", () => {
    expect(clampConversationWidth(520, WIDE)).toBe(520);
  });

  test("it cannot be dragged past the minimum", () => {
    expect(clampConversationWidth(10, WIDE)).toBe(CONVERSATION_MIN);
    expect(clampConversationWidth(-400, WIDE)).toBe(CONVERSATION_MIN);
  });

  test("it cannot be dragged past the maximum", () => {
    expect(clampConversationWidth(5000, WIDE)).toBe(CONVERSATION_MAX);
  });

  test("the document keeps its own floor", () => {
    // In a window with less room than the maximum, the ceiling is whatever
    // is left after the document's floor — not the maximum.
    const w = 900;
    expect(clampConversationWidth(5000, w)).toBe(w - DOCUMENT_MIN);
  });

  test("in a window too narrow for both, the conversation still opens", () => {
    // Below the point where both floors fit, the minimum wins. A pane at
    // zero has no edge to grab.
    expect(clampConversationWidth(500, 400)).toBe(CONVERSATION_MIN);
    expect(clampConversationWidth(10, 400)).toBe(CONVERSATION_MIN);
  });

  test("a width that is not a number is the minimum", () => {
    // One rule for every non-finite value rather than a special case per
    // kind. No drag produces any of them; this is only about not rendering
    // a pane whose width is NaN.
    expect(clampConversationWidth(Number.NaN, WIDE)).toBe(CONVERSATION_MIN);
    expect(clampConversationWidth(Number.POSITIVE_INFINITY, WIDE)).toBe(CONVERSATION_MIN);
  });

  test("it is a whole number of pixels", () => {
    expect(clampConversationWidth(420.7, WIDE)).toBe(421);
  });
});

describe("remembering it", () => {
  const fake = () => {
    const held = new Map<string, string>();
    return {
      held,
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => {
        held.set(k, v);
      },
    };
  };

  test("what was written is what is read back", () => {
    const store = fake();
    writeConversationWidth(store, 512);
    expect(store.held.get(STORAGE_KEY)).toBe("512");
    expect(readConversationWidth(store)).toBe(512);
  });

  test("nothing stored means nothing to apply", () => {
    expect(readConversationWidth(fake())).toBe(null);
    expect(readConversationWidth(null)).toBe(null);
  });

  test("rubbish in storage is ignored, not applied", () => {
    const store = fake();
    store.held.set(STORAGE_KEY, "wide please");
    expect(readConversationWidth(store)).toBe(null);
    store.held.set(STORAGE_KEY, "0");
    expect(readConversationWidth(store)).toBe(null);
  });

  test("a browser that refuses storage does not take the page with it", () => {
    // Private windows and browsers set to block site data throw on access
    // rather than returning nothing.
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readConversationWidth(throwing)).toBe(null);
    expect(() => writeConversationWidth(throwing, 400)).not.toThrow();
  });
});

describe("the stacked document share", () => {
  test("keeps a requested share within both pane limits", () => {
    expect(clampDocumentShare(0.4)).toBe(0.4);
    expect(clampDocumentShare(-1)).toBe(0.15);
    expect(clampDocumentShare(2)).toBe(0.7);
  });
  test("invalid measurements restore the conversation to the bottom third", () => {
    expect(clampDocumentShare(Number.NaN)).toBe(2 / 3);
    expect(clampDocumentShare(Number.POSITIVE_INFINITY)).toBe(2 / 3);
  });
});
