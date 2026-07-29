/**
 * Source-level HTML scanning that honors the parser's hiding rules (plan 04).
 *
 * Two consumers care where markup is REAL in the raw source: overlay
 * injection must splice at the `</body>` the parser honors (#44), and
 * structural validation must not count a literal `</html>` sitting inside a
 * textarea as a closing root. Both walk the source with one tokenizer-lite:
 * comments (including HTML5's abrupt closes `<!-->`/`<!--->` and `--!>`),
 * rawtext/RCDATA elements, `plaintext`, and QUOTED ATTRIBUTE VALUES are
 * opaque - a `</body>` inside any of them is text, never a close.
 *
 * `closeIndexOf` is a zero-allocation skip-scan (beyond one lowercase copy):
 * it runs on every artifact GET, on the daemon's shared event loop, so a
 * masked-copy implementation measurably stalled every hosted session on a
 * multi-megabyte document (D-019 review, F1). Only the validator pays for a
 * materialized mask.
 */

/** Elements whose content the HTML parser treats as raw text or RCDATA: a
 *  literal `</body>` inside them is TEXT. `plaintext` is handled separately -
 *  it swallows the remainder of the document. */
const RAWTEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

const isNameChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9-]/.test(c);

/** The index just past a tag token's closing `>`, honoring quoted attribute
 *  values (`<div title="a>b">` ends after the second `>`), or -1 at EOF. */
const endOfTag = (lower: string, from: number): number => {
  let i = from;
  while (i < lower.length) {
    const c = lower[i];
    if (c === '"' || c === "'") {
      const close = lower.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (c === ">") return i + 1;
    i += 1;
  }
  return -1;
};

/** The tag name starting at `from` (already past `<` or `</`). */
const tagNameAt = (lower: string, from: number): string => {
  let end = from;
  while (end < lower.length && isNameChar(lower[end])) end += 1;
  return lower.slice(from, end);
};

/** Past the end of a comment opened at `at` (`<!--`), honoring the abrupt
 *  closes (`<!-->`, `<!--->`) and `--!>`; -1 when unterminated. */
const endOfComment = (lower: string, at: number): number => {
  if (lower.startsWith(">", at + 4)) return at + 5; // <!-->
  if (lower.startsWith("->", at + 4)) return at + 6; // <!--->
  const normal = lower.indexOf("-->", at + 4);
  const bang = lower.indexOf("--!>", at + 4);
  if (normal === -1 && bang === -1) return -1;
  if (normal === -1) return bang + 4;
  if (bang === -1 || normal < bang) return normal + 3;
  return bang + 4;
};

/** Script data has ESCAPE states the other rawtext elements lack (HTML5
 *  tokenizer): `<!--` enters escaped; an inner `<script` while escaped enters
 *  double-escaped, where `</script>` is consumed as text instead of closing
 *  the element; `-->` leaves both. The D-019 review's F2 double-escape case
 *  is exactly this - a wrong early close put the splice inside a JS string. */
const endOfScript = (lower: string, from: number): number => {
  let i = from;
  let escaped = false;
  let dbl = false;
  while (i < lower.length) {
    if (!escaped && lower.startsWith("<!--", i)) {
      escaped = true;
      i += 4;
      continue;
    }
    if (escaped && lower.startsWith("-->", i)) {
      escaped = false;
      dbl = false;
      i += 3;
      continue;
    }
    if (escaped && !dbl && lower.startsWith("<script", i) && !isNameChar(lower[i + 7])) {
      dbl = true;
      i += 7;
      continue;
    }
    if (lower.startsWith("</script", i) && !isNameChar(lower[i + 8])) {
      if (dbl) {
        dbl = false; // consumed as script text; the element stays open
        i += 8;
        continue;
      }
      const end = endOfTag(lower, i + 8);
      return end === -1 ? -1 : end;
    }
    i += 1;
  }
  return -1;
};

/** Past the end of a rawtext element's content: the index just past the `>`
 *  of its APPROPRIATE end tag (`</name` followed by a non-name char, so
 *  `</scripting>` never ends a script - D-019 review, F2); -1 when the
 *  content runs to EOF. Script gets the escape-state walk above. */
const endOfRawtext = (lower: string, name: string, from: number): number => {
  if (name === "script") return endOfScript(lower, from);
  let k = from;
  const close = `</${name}`;
  while (true) {
    k = lower.indexOf(close, k);
    if (k === -1) return -1;
    if (!isNameChar(lower[k + close.length])) {
      const end = endOfTag(lower, k + close.length);
      return end === -1 ? -1 : end;
    }
    k += close.length;
  }
};

/**
 * The source index of the close tag the parser would honor, or -1. A single
 * forward walk: jump whole comments, whole rawtext contents, and whole tag
 * tokens (so an attribute value's `</body>` is inside a token, never a
 * candidate). `plaintext` ends the walk - everything after it is text.
 */
export const closeIndexOf = (html: string, tag: string): number => {
  const lower = html.toLowerCase();
  const target = `</${tag}`;
  let i = 0;
  while (i < lower.length) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) return -1;
    if (lower.startsWith("<!--", lt)) {
      const end = endOfComment(lower, lt);
      if (end === -1) return -1; // unterminated comment swallows the rest
      i = end;
      continue;
    }
    if (lower.startsWith(target, lt) && !isNameChar(lower[lt + target.length])) {
      return lt;
    }
    if (lower.startsWith("</", lt)) {
      const end = endOfTag(lower, lt + 2);
      i = end === -1 ? lower.length : end;
      continue;
    }
    const name = tagNameAt(lower, lt + 1);
    if (name.length === 0) {
      // `<!doctype`, `<?...`, or a stray `<`: bogus-comment/text - skip past
      // the next `>` when it is markup-ish, else just the `<`.
      if (lower.startsWith("<!", lt) || lower.startsWith("<?", lt)) {
        const gt = lower.indexOf(">", lt);
        i = gt === -1 ? lower.length : gt + 1;
      } else {
        i = lt + 1;
      }
      continue;
    }
    const end = endOfTag(lower, lt + 1 + name.length);
    if (end === -1) return -1; // truncated inside a tag
    if (name === "plaintext") return -1; // the rest of the document is text
    if (RAWTEXT.has(name)) {
      const after = endOfRawtext(lower, name, end);
      if (after === -1) return -1; // unterminated rawtext swallows the rest
      i = after;
      continue;
    }
    i = end;
  }
  return -1;
};

/**
 * The source with every hidden byte blanked to a space - comment interiors,
 * rawtext/RCDATA content, everything after a `plaintext` open, and QUOTED
 * ATTRIBUTE VALUES (so `<div data-tpl="<script>">` neither opens rawtext nor
 * miscounts a script) - while EVERY index keeps its position. Built from
 * slices, not per-character arrays; only the validator pays for it.
 */
export const maskHiddenText = (html: string): string => {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let emitted = 0; // everything before this index is already in parts
  const keepUpTo = (idx: number): void => {
    if (idx > emitted) parts.push(html.slice(emitted, idx));
    emitted = idx;
  };
  const blankUpTo = (idx: number): void => {
    if (idx > emitted) parts.push(" ".repeat(idx - emitted));
    emitted = idx;
  };
  /** Emit a tag token keeping its markup but blanking quoted values. */
  const emitTag = (from: number, to: number): void => {
    let i = from;
    while (i < to) {
      const c = lower[i];
      if (c === '"' || c === "'") {
        const close = lower.indexOf(c, i + 1);
        const valueEnd = close === -1 || close >= to ? to : close;
        keepUpTo(i + 1);
        blankUpTo(valueEnd);
        i = valueEnd + 1;
        continue;
      }
      i += 1;
    }
    keepUpTo(to);
  };

  let i = 0;
  while (i < lower.length) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) break;
    if (lower.startsWith("<!--", lt)) {
      const end = endOfComment(lower, lt);
      keepUpTo(lt + 4);
      if (end === -1) {
        blankUpTo(lower.length);
        break;
      }
      // keep the terminator's own bytes visible; blank only the interior
      const termLen = lower.startsWith("--!>", end - 4)
        ? 4
        : end - (lt + 4) < 3
          ? end - (lt + 4)
          : 3;
      blankUpTo(end - termLen);
      keepUpTo(end);
      i = end;
      continue;
    }
    if (lower.startsWith("</", lt)) {
      const end = endOfTag(lower, lt + 2);
      if (end === -1) {
        keepUpTo(lower.length);
        break;
      }
      keepUpTo(end);
      i = end;
      continue;
    }
    const name = tagNameAt(lower, lt + 1);
    if (name.length === 0) {
      const gt =
        lower.startsWith("<!", lt) || lower.startsWith("<?", lt) ? lower.indexOf(">", lt) : -1;
      keepUpTo(gt === -1 ? lt + 1 : gt + 1);
      i = emitted;
      continue;
    }
    const end = endOfTag(lower, lt + 1 + name.length);
    if (end === -1) {
      keepUpTo(lower.length);
      break;
    }
    emitTag(lt, end);
    i = end;
    if (name === "plaintext") {
      blankUpTo(lower.length);
      break;
    }
    if (RAWTEXT.has(name)) {
      const after = endOfRawtext(lower, name, end);
      if (after === -1) {
        blankUpTo(lower.length);
        break;
      }
      // blank the content; keep the end tag's markup visible
      const closeStart = lower.lastIndexOf(`</${name}`, after);
      blankUpTo(closeStart);
      keepUpTo(after);
      i = after;
    }
  }
  keepUpTo(lower.length);
  return parts.join("");
};
