import { describe, expect, test } from "bun:test";
import {
  CHAT_REFERENCE_FENCE,
  detectChatReferences,
  stripChatReferences,
} from "../../src/protocol/chat-references.js";

const fence = (body: string): string =>
  `See the section below.\n\`\`\`${CHAT_REFERENCE_FENCE}\n${body}\n\`\`\`\nDone.`;

describe("chat references", () => {
  test("detects a valid block with quote and label", () => {
    const blocks = detectChatReferences(
      fence(
        JSON.stringify({
          artifactId: "doc-1",
          version: 3,
          refs: [{ quote: "Next survey", label: "Next survey section" }],
        }),
      ),
    );
    expect(blocks).toEqual([
      {
        artifactId: "doc-1",
        version: 3,
        refs: [{ quote: "Next survey", label: "Next survey section" }],
      },
    ]);
  });

  test("strip drops the fence entirely; the prose already names the location", () => {
    const stripped = stripChatReferences(
      `See the [Next survey section] below.\n${fence(
        JSON.stringify({
          artifactId: "doc-1",
          version: 3,
          refs: [{ quote: "Next survey", label: "Next survey section" }],
        }),
      )}`,
    );
    expect(stripped).toContain("See the [Next survey section] below.");
    expect(stripped).not.toContain("lucid-references");
    expect(stripped).not.toContain('Next survey",');
    // One bracketed label, not two: the fence adds no duplicate.
    expect(stripped.match(/\[Next survey section\]/g)?.length).toBe(1);
  });

  test("malformed JSON is not a reference and strips to nothing", () => {
    const text = fence("not json");
    expect(detectChatReferences(text)).toEqual([]);
    const stripped = stripChatReferences(text);
    expect(stripped).toContain("See the section below.");
    expect(stripped).not.toContain("not json");
  });

  test("wrong shape is not a reference", () => {
    const text = fence(JSON.stringify({ nope: true }));
    expect(detectChatReferences(text)).toEqual([]);
  });

  test("empty quotes and labels are dropped; all-empty yields no block", () => {
    const text = fence(
      JSON.stringify({
        artifactId: "doc-1",
        version: 1,
        refs: [
          { quote: "  ", label: "x" },
          { quote: "y", label: "" },
        ],
      }),
    );
    expect(detectChatReferences(text)).toEqual([]);
  });

  test("refs are capped at twenty per message, across fences", () => {
    const refs = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        quote: `passage ${from + i}`,
        label: `section ${from + i}`,
      }));
    const body = (r: readonly { quote: string; label: string }[]) =>
      `\`\`\`${CHAT_REFERENCE_FENCE}\n${JSON.stringify({
        artifactId: "doc-1",
        version: 1,
        refs: r,
      })}\n\`\`\``;
    const text = `${body(refs(0, 15))}\n${body(refs(15, 15))}`;
    const blocks = detectChatReferences(text);
    const total = blocks.reduce((n, b) => n + b.refs.length, 0);
    expect(total).toBe(20);
    // The second fence keeps only what the budget has room for.
    expect(blocks[1]?.refs.length).toBe(5);
  });

  test("an overlong quote is dropped, not cut", () => {
    // Cutting appends a character the document never held, which breaks
    // the verbatim match the link depends on. Dropping keeps exact-quote
    // semantics: what survives matches byte for byte.
    const quote = "x".repeat(3000);
    const blocks = detectChatReferences(
      fence(JSON.stringify({ artifactId: "doc-1", version: 1, refs: [{ quote, label: "L" }] })),
    );
    expect(blocks).toEqual([]);
  });

  test("text without a fence has no references and strips unchanged", () => {
    expect(detectChatReferences("plain prose")).toEqual([]);
    expect(stripChatReferences("plain prose")).toBe("plain prose");
  });
});
