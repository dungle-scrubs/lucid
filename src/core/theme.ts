/**
 * Is this artifact ready to be re-themed?
 *
 * Lucid's viewer owns the light/dark choice for every open artifact and drives
 * it by setting `data-lucid-theme` on `<html>` and remapping six standard
 * tokens. That only reaches an artifact whose colors go THROUGH those tokens -
 * a hardcoded `#fff` ignores the reader entirely.
 *
 * So this is checked where the author can still act on it (`lucid open`) rather
 * than discovered by a human at midnight wondering why one document stayed
 * bright. A warning, never a refusal: an artifact may legitimately carry fixed
 * colors (a chart series, a brand mark), and Lucid does not get to veto that.
 */

import { THEME_TOKENS } from "./palette.ts";

export interface ThemeReadiness {
  /** The artifact remaps tokens for dark, so it has an author-tuned dark form. */
  readonly hasDarkBlock: boolean;
  /** It declares the standard tokens at all. */
  readonly usesTokens: boolean;
  /** Color literals used OUTSIDE a custom-property declaration, deduped, in the
   *  order found. These are the ones a theme switch cannot reach. */
  readonly hardcoded: readonly string[];
}

/** `#abc`, `#aabbcc`, `#aabbccdd`, `rgb(…)`, `rgba(…)`, `hsl(…)`, `hsla(…)`. */
const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi;

/** A line that DEFINES a token is where a literal belongs. */
const DECLARES_TOKEN = /(^|[;{\s])--[a-z0-9-]+\s*:/i;

/**
 * Strip what must not be scanned: an artifact's own `<script>` payloads and
 * HTML comments routinely carry color-shaped strings that no stylesheet reads.
 */
const scannable = (html: string): string =>
  html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");

export const themeReadiness = (html: string): ThemeReadiness => {
  const body = scannable(html);
  const hasDarkBlock =
    /prefers-color-scheme\s*:\s*dark/i.test(body) || /data-lucid-theme\s*=\s*["']?dark/i.test(body);
  const usesTokens = THEME_TOKENS.some((t) => new RegExp(`${t}\\s*:`).test(body));

  const hardcoded: string[] = [];
  const seen = new Set<string>();
  // Line by line, because "is this literal defining a token" is a property of
  // the declaration it sits in, and a declaration does not span lines in any
  // stylesheet a human wrote.
  for (const line of body.split("\n")) {
    if (DECLARES_TOKEN.test(line)) continue;
    for (const match of line.match(COLOR) ?? []) {
      const value = match.toLowerCase();
      if (seen.has(value)) continue;
      seen.add(value);
      hardcoded.push(match);
    }
  }
  return { hasDarkBlock, usesTokens, hardcoded };
};

/** How many literals to name before the list stops being useful. */
const SHOWN = 3;

/**
 * The warning to print, or undefined when there is nothing worth saying. Kept
 * beside the check so the wording and the rule cannot drift apart.
 */
export const themeWarning = (readiness: ThemeReadiness): string | undefined => {
  const { hasDarkBlock, usesTokens, hardcoded } = readiness;
  if (hasDarkBlock && hardcoded.length === 0) return undefined;
  const parts: string[] = [];
  if (hardcoded.length > 0) {
    const shown = hardcoded.slice(0, SHOWN).join(", ");
    const rest = hardcoded.length > SHOWN ? `, +${hardcoded.length - SHOWN} more` : "";
    parts.push(
      `${hardcoded.length} hardcoded ${hardcoded.length === 1 ? "color" : "colors"} (${shown}${rest})`,
    );
  }
  if (!hasDarkBlock) parts.push("no dark palette");
  if (!usesTokens) parts.push(`none of ${THEME_TOKENS.slice(0, 3).join("/")} declared`);
  return (
    `this artifact will not fully follow the viewer's light/dark choice: ${parts.join("; ")}. ` +
    `Route colors through ${THEME_TOKENS.slice(0, 2).join("/")}… and remap them in a ` +
    `@media (prefers-color-scheme: dark) block - see the lucid-design skill.`
  );
};
