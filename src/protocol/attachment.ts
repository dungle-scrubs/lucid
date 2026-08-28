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
