/**
 * An artifact's own title, and the filename a title implies.
 *
 * The document already carries what it is called - its `<title>` - so the
 * shell shows THAT on a tab rather than a filename. "Units that got away"
 * says what a tab holds; "test2.html" says where it happens to live.
 */

/** How much of an artifact to read looking for its title. `<title>` lives in
 *  the head, and a document whose head is past this is not one Lucid wrote. */
export const TITLE_SCAN_BYTES = 8192;

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/**
 * The `<title>` of an HTML head, or null when there is none. Entities are
 * decoded because the title is displayed as text, and the result is bounded
 * and control-stripped: it rides into the listing every consumer renders.
 */
export const parseTitle = (html: string): string | null => {
  const m = TITLE_RE.exec(html);
  if (!m?.[1]) return null;
  const text = m[1]
    .replace(/&(#?[a-z0-9]+);/gi, (whole, key: string) => ENTITIES[key.toLowerCase()] ?? whole)
    .split("")
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 120) : null;
};

/**
 * A filename from a title: lowercase, words joined by dashes, everything the
 * create route's name rule would reject dropped. Empty when the title has no
 * usable characters at all (an emoji-only title), so the caller keeps whatever
 * the human typed rather than showing them a blank field.
 */
export const handleize = (title: string): string =>
  title
    .normalize("NFKD")
    // Strip combining marks so "Café" handleizes to "cafe", not "cafa".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // The route's own cap, minus room for ".html".
    .slice(0, 75)
    .replace(/-+$/g, "");
