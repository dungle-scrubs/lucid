/**
 * What an attachment is, and whether its bytes are text (RFC-11).
 *
 * Two rules, both of them decisions with a wrong answer available.
 *
 * **The bound** is policy. 25 MB admits any screenshot, photograph or PDF and
 * keeps out video, which no agent can use. It is deliberately not
 * `ARTIFACT_BYTES_MAX`: that bound is 1 MB because an artifact is stored as a
 * line *in* the log, and a blob is not - it is a file beside it, hashed once
 * on the way in.
 *
 * **Whether a file is text** decides whether its contents go into an input.
 * Getting it wrong is the expensive direction: a binary read as text puts
 * control characters into an input, and the store refuses those in every
 * field it holds. So the test is on the bytes. The media type arrives from
 * the browser and states what the sender claims; the extension states less
 * than that. Neither decides this.
 */

/** The most a single attachment may be. Policy, not measured (RFC-11).
 *
 * Stated as a number with a reason, the way `PATCH_EDITS_MAX` and
 * `ARTIFACT_TITLE_MAX` are, because an unnamed bound is not a bound. */
export const ATTACHMENT_BYTES_MAX = 25_000_000;

/** Bytes that never appear in text.
 *
 * Everything below 0x20 except tab, newline and carriage return, plus
 * DEL. The same class the record refuses in every field it stores, for the
 * same reason: an inlined file becomes part of an input. */
const isControl = (b: number): boolean =>
  (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f;

/**
 * Whether these bytes may be inlined into an input.
 *
 * Total, and cheap: it decodes once with a strict decoder and walks once. An
 * empty file is text - it decodes, and it carries nothing that is not text.
 * That is stated here rather than left to a caller to discover, because "is
 * nothing text" is exactly the question a test finds and an implementation
 * forgets.
 */
export const isTextBytes = (bytes: Uint8Array): boolean => {
  // Strict, so invalid UTF-8 throws rather than becoming replacement
  // characters. A file that is not valid UTF-8 is not text lucid will inline:
  // the input it would join is UTF-8 all the way down.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const b of bytes) if (isControl(b)) return false;
  return true;
};

/** Whether a file of this size may be stored at all. */
export const withinAttachmentBound = (size: number): boolean =>
  Number.isSafeInteger(size) && size >= 0 && size <= ATTACHMENT_BYTES_MAX;

/** Image types lucid will serve back to its own page, decided by the bytes.
 *
 * The sender's `contentType` is never used for this. It is a claim, and
 * letting a claim choose how a browser renders bytes is how an attachment
 * becomes a script. These four are recognised by their magic bytes, are
 * rendered as pictures by every browser, and cannot carry script.
 *
 * SVG is deliberately absent. It is an image and it is also a document that
 * can carry script, so serving it as an image would undo the guard. */
export const sniffImageType = (bytes: Uint8Array): string | null => {
  const at = (i: number): number => bytes[i] ?? -1;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  // GIF87a / GIF89a
  if (
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38 &&
    (at(4) === 0x37 || at(4) === 0x39) &&
    at(5) === 0x61
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
};
