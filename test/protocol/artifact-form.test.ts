/**
 * RFC-08 R1: the header says what its body is, and a form lucid does not
 * know is refused rather than assumed.
 *
 * The whole point of the default is that nothing already written changes
 * meaning, so most of this file is about blocks that say nothing about
 * `form` at all.
 */
import { describe, expect, test } from "bun:test";
import {
  detectArtifactBlocks,
  quoteForRefusal,
  REFUSAL_QUOTE_MAX,
} from "../../src/protocol/artifacts.js";

/** A fence whose header is exactly the object given, so a test can put a
 * `form` in it or leave it out. */
const fence = (header: Record<string, unknown>, bytes: string) =>
  `\`\`\`lucid-artifact\n${JSON.stringify(header)}\n${bytes}\n\`\`\``;

const base = { id: "doc-1", replaces: null, contentType: "text/html" };

/** The single detection in `text`, asserted here so no call site has to
 * narrow an index that cannot be undefined. */
const one = (text: string) => {
  const found = detectArtifactBlocks(text);
  expect(found.length).toBe(1);
  const first = found[0];
  if (first === undefined) throw new Error("expected one detection");
  return first;
};

describe("the default form", () => {
  test("a header with no form is a whole document, exactly as before", () => {
    const d = one(fence(base, "<p>hi</p>"));
    expect("block" in d).toBe(true);
    if (!("block" in d)) return;
    expect(d.block.header.form).toBe("whole");
    expect(d.block.bytes).toBe("<p>hi</p>");
    expect(d.block.header.id).toBe("doc-1");
  });

  test('form: "whole" means the same thing as saying nothing', () => {
    const without = one(fence(base, "<p>hi</p>"));
    const with_ = one(fence({ ...base, form: "whole" }, "<p>hi</p>"));
    if (!("block" in without) || !("block" in with_)) throw new Error("expected blocks");
    // Not the whole detection: `rawBody` is the literal fence text, which
    // differs because one of them spells the default out.
    expect(without.block.header).toEqual(with_.block.header);
    expect(without.block.bytes).toBe(with_.block.bytes);
  });

  test("the form is always set, so no reader has to remember the default", () => {
    // Normalising at the parser is what lets every caller downstream branch
    // on header.form without an `?? "whole"` that someone will forget.
    const d = one(fence(base, "x"));
    if (!("block" in d)) throw new Error("expected a block");
    expect(d.block.header.form).toBeDefined();
  });
});

describe("a form lucid does not know", () => {
  test('form: "patch" parses, because RFC-08 defines it', () => {
    const d = one(fence({ ...base, replaces: 3, form: "patch" }, '{"edits":[]}'));
    expect("block" in d).toBe(true);
    if (!("block" in d)) return;
    expect(d.block.header.form).toBe("patch");
    // The body is carried through untouched. Whether it is a valid patch is
    // not the parser's question.
    expect(d.block.bytes).toBe('{"edits":[]}');
  });

  test("any other value is refused, not assumed to be whole", () => {
    // Guessing "whole" would store a body that is not a document as though
    // it were one, which is the failure E-PATCH-07 exists to prevent.
    for (const form of ["patch ", "PATCH", "diff", "regex", "", "wholesome"]) {
      const d = one(fence({ ...base, form }, "<p>hi</p>"));
      expect("malformed" in d).toBe(true);
      if (!("malformed" in d)) continue;
      expect(d.malformed).toContain("E-PATCH-07");
    }
  });

  test("a form that is not a string is refused too", () => {
    for (const form of [1, true, null, ["patch"], { form: "patch" }]) {
      const d = one(fence({ ...base, form }, "<p>hi</p>"));
      expect("malformed" in d).toBe(true);
    }
  });

  test("the refusal says what it saw, so the agent can fix it", () => {
    const d = one(fence({ ...base, form: "diff" }, "<p>hi</p>"));
    if (!("malformed" in d)) throw new Error("expected a refusal");
    expect(d.malformed).toContain('"diff"');
    expect(d.malformed).toContain("whole");
    expect(d.malformed).toContain("patch");
  });

  test("a refused block does not take a valid one down with it", () => {
    // Two blocks in one message walk the machine independently (RFC-06).
    const text = `${fence({ ...base, form: "diff" }, "bad")}\n\n${fence({ ...base, id: "doc-2" }, "good")}`;
    const [first, second] = detectArtifactBlocks(text);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first !== undefined && "malformed" in first).toBe(true);
    expect(second !== undefined && "block" in second).toBe(true);
  });
});

describe("quoting agent text back in a refusal", () => {
  test("short text is quoted whole", () => {
    expect(quoteForRefusal("diff")).toBe('"diff"');
  });

  test("long text is cut, so a refusal cannot be used to write length into the log", () => {
    const huge = "x".repeat(10_000);
    const q = quoteForRefusal(huge);
    expect(Buffer.byteLength(q, "utf8")).toBeLessThanOrEqual(REFUSAL_QUOTE_MAX);
    expect(q.endsWith("…")).toBe(true);
  });

  test("the bound is bytes, not UTF-16 code units", () => {
    // A review measured this: 128 characters of a three-byte code point used
    // to quote to 386 bytes against a stated bound of 200, because
    // String.prototype.length counts units and the log stores UTF-8.
    for (const ch of ["界", "🙂", "é", "x"]) {
      const q = quoteForRefusal(ch.repeat(500));
      expect(Buffer.byteLength(q, "utf8")).toBeLessThanOrEqual(REFUSAL_QUOTE_MAX);
    }
  });

  test("it cuts on a character boundary, never inside one", () => {
    // Slicing UTF-8 at a fixed byte count can land inside a character and
    // write a replacement character into the log.
    const q = quoteForRefusal("界".repeat(500));
    expect(q).not.toContain("\ufffd");
    // Round-trips, so no half character survived.
    expect([...q].every((c) => c.length <= 2)).toBe(true);
  });

  test("text already within the bound is quoted whole and unmarked", () => {
    const q = quoteForRefusal("界界界");
    expect(q).toBe('"界界界"');
    expect(q.endsWith("…")).toBe(false);
  });

  test("a refusal for an enormous form is bounded", () => {
    const d = one(fence({ ...base, form: "y".repeat(50_000) }, "<p>hi</p>"));
    if (!("malformed" in d)) throw new Error("expected a refusal");
    // The reason is a sentence plus a bounded quote, not the agent's string.
    expect(d.malformed.length).toBeLessThan(500);
  });

  test("control characters cannot break the reason onto another line", () => {
    const q = quoteForRefusal("a\nb\tc");
    expect(q).not.toContain("\n");
    expect(q).not.toContain("\t");
  });
});
