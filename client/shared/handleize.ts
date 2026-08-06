/**
 * A filename from a title (M4.5, moved from `src/core/title.ts` so the create
 * dialog stops importing a server-tier module directly): lowercase, words
 * joined by dashes, everything the create route's name rule would reject
 * dropped. Empty when the title has no usable characters at all (an emoji-only
 * title), so the caller keeps whatever the human typed rather than showing a
 * blank field. Pure, with no server dependents.
 */
export const handleize = (title: string): string =>
  title
    .normalize("NFKD")
    // Strip combining marks so "Café" handleizes to "cafe", not "cafa".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // The route's own cap, minus room for ".html".
    .slice(0, 75)
    .replace(/-+$/g, "");
