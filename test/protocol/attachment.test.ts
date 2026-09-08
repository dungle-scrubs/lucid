/**
 * Whether an attachment's bytes may be inlined into an input (RFC-11).
 *
 * The expensive direction is calling a binary text: its bytes would join an
 * input, and the store refuses control characters in every field it holds. So
 * most of what is asserted here is that a claim about a file - its media
 * type, its extension - never decides the answer.
 */
import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_BYTES_MAX,
  isTextBytes,
  sniffImageType,
  withinAttachmentBound,
} from "../../src/protocol/attachment.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("what counts as text", () => {
  test("plain prose, source, CSV, JSON and markdown", () => {
    for (const s of [
      "hello",
      "const x = 1;\nexport default x;\n",
      "a,b,c\n1,2,3\n",
      '{"a":1}',
      "# Title\n\n- one\n- two\n",
    ]) {
      expect(isTextBytes(bytes(s))).toBe(true);
    }
  });

  test("tab, newline and carriage return are text", () => {
    expect(isTextBytes(bytes("a\tb\nc\r\nd"))).toBe(true);
  });

  test("an empty file is text", () => {
    // Stated rather than left to be discovered: "is nothing text" is the
    // question a test finds and an implementation forgets.
    expect(isTextBytes(new Uint8Array(0))).toBe(true);
  });

  test("text beyond ASCII is text", () => {
    expect(isTextBytes(bytes("héllo — 日本語 — 🙂"))).toBe(true);
  });
});

describe("what is not text", () => {
  test("a null byte, wherever it sits", () => {
    expect(isTextBytes(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
    expect(isTextBytes(new Uint8Array([0x00]))).toBe(false);
  });

  test("other control characters", () => {
    for (const b of [0x01, 0x07, 0x08, 0x0b, 0x0c, 0x1f, 0x7f]) {
      expect(isTextBytes(new Uint8Array([0x61, b, 0x62]))).toBe(false);
    }
  });

  test("a PNG header", () => {
    expect(isTextBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      false,
    );
  });

  test("a PDF, which begins with readable text and is not text", () => {
    const pdf = new Uint8Array([...bytes("%PDF-1.7\n"), 0x00, 0x01, 0x02]);
    expect(isTextBytes(pdf)).toBe(false);
  });

  test("invalid UTF-8", () => {
    // A lone continuation byte. A lenient decoder turns this into a
    // replacement character and calls it text; a strict one does not.
    expect(isTextBytes(new Uint8Array([0x61, 0x80, 0x62]))).toBe(false);
    // A truncated multi-byte sequence.
    expect(isTextBytes(new Uint8Array([0xe6, 0x97]))).toBe(false);
  });
});

describe("a claim about a file never decides it", () => {
  test("bytes that are binary are binary whatever they are called", () => {
    // The caller may have been told this is text/plain and named it .md.
    // Neither is evidence, and neither is consulted - the function takes
    // bytes and nothing else, which is the point.
    const claimingToBeMarkdown = new Uint8Array([...bytes("# Title\n"), 0x00]);
    expect(isTextBytes(claimingToBeMarkdown)).toBe(false);
  });

  test("bytes that are text are text whatever they are called", () => {
    expect(isTextBytes(bytes("plain words"))).toBe(true);
  });
});

describe("the size bound", () => {
  test("the bound is a stated number", () => {
    expect(ATTACHMENT_BYTES_MAX).toBe(25_000_000);
  });

  test("it is larger than an artifact's, because a blob is not a log line", () => {
    // ARTIFACT_BYTES_MAX is 1 MB. A screenshot is several.
    expect(ATTACHMENT_BYTES_MAX).toBeGreaterThan(1_000_000);
  });

  test("inclusive, and one past it is not", () => {
    expect(withinAttachmentBound(ATTACHMENT_BYTES_MAX)).toBe(true);
    expect(withinAttachmentBound(ATTACHMENT_BYTES_MAX + 1)).toBe(false);
  });

  test("zero is allowed and nonsense is not", () => {
    expect(withinAttachmentBound(0)).toBe(true);
    expect(withinAttachmentBound(-1)).toBe(false);
    expect(withinAttachmentBound(1.5)).toBe(false);
    expect(withinAttachmentBound(Number.NaN)).toBe(false);
    expect(withinAttachmentBound(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("what type an attachment is served as", () => {
  test("a PNG is recognised by its bytes", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
  });

  test("JPEG, GIF and WEBP", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(bytes("GIF89a......"))).toBe("image/gif");
    expect(sniffImageType(bytes("RIFF....WEBPVP8 "))).toBe("image/webp");
  });

  test("anything else is not an image", () => {
    expect(sniffImageType(bytes("plain text"))).toBeNull();
    expect(sniffImageType(bytes("%PDF-1.7"))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  test("SVG is not served as an image, whatever it claims", () => {
    // It is an image and also a document that can carry script. Serving it as
    // an image would undo the guard the sniff exists for.
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  test("HTML pretending to be a PNG is not an image", () => {
    // The name and the media type are the sender's claims. The bytes are not.
    expect(sniffImageType(bytes("<script>alert(1)</script>"))).toBeNull();
  });

  test("a truncated header is not an image", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});
