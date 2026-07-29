/**
 * Source-level HTML scanning that honors the parser's hiding rules (plan 04).
 *
 * Two consumers care where markup is REAL in the raw source: overlay injection
 * must splice at the `</body>` the parser honors (#44), and structural
 * validation must not count a literal `</html>` sitting inside a textarea as a
 * closing root. Both were regex passes over the raw text, blind to comments
 * and rawtext/RCDATA content; both now look through this one mask.
 */

/** Elements whose content the HTML parser treats as raw text or RCDATA: a
 *  literal `</body>` inside them is TEXT, never a close. */
const RAWTEXT = ["script", "style", "textarea", "title"] as const;

/**
 * The source with every hidden byte blanked to a space: comment interiors and
 * rawtext/RCDATA content become whitespace while EVERY index keeps its
 * position, so a regex match on the mask is a valid splice offset into the
 * original. The rawtext elements' own tags stay visible (they are markup);
 * only their content is hidden. An unterminated comment or rawtext section
 * hides everything after it - exactly what the parser would swallow.
 */
export const maskHiddenText = (html: string): string => {
  const lower = html.toLowerCase();
  const out = html.split("");
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
  };
  let i = 0;
  while (i < lower.length) {
    if (lower.startsWith("<!--", i)) {
      const end = lower.indexOf("-->", i + 4);
      if (end === -1) {
        blank(i + 4, lower.length);
        break;
      }
      blank(i + 4, end);
      i = end + 3;
      continue;
    }
    const raw = RAWTEXT.find(
      (t) => lower.startsWith(`<${t}`, i) && !/[a-z0-9-]/.test(lower[i + t.length + 1] ?? ""),
    );
    if (raw !== undefined) {
      const openEnd = lower.indexOf(">", i);
      if (openEnd === -1) {
        blank(i + 1, lower.length);
        break;
      }
      const closeAt = lower.indexOf(`</${raw}`, openEnd + 1);
      if (closeAt === -1) {
        blank(openEnd + 1, lower.length);
        break;
      }
      blank(openEnd + 1, closeAt);
      i = closeAt;
      continue;
    }
    i += 1;
  }
  return out.join("");
};

/**
 * The source index of the close tag the parser would honor, or -1. Matching
 * runs on the mask; the index is valid in the original by construction.
 */
export const closeIndexOf = (html: string, tag: string): number => {
  const re = new RegExp(`</${tag}\\s*>`, "i");
  const m = re.exec(maskHiddenText(html));
  return m === null ? -1 : m.index;
};
