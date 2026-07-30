/**
 * The unified session list's data rules (plan 03, M4.1). One vocabulary for
 * both mounts - the ⌘K palette and the pick screen - so the two surfaces
 * cannot drift: the recency band, the open/openable split, and the fuzzy
 * search value are decided here and merely rendered there.
 */

import type { HubSession } from "./hub.ts";
import { projectName, sessionLabel } from "./naming.ts";

/** How many rows the recency band offers. Enough to cover "the things I was
 *  just working on" without becoming a second full list. */
export const BAND_SIZE = 5;

/** The most recently seen sessions, newest first, across ALL projects -
 *  ordered by the hub's own `lastSeen` (D-024), which tracks opens and scans
 *  rather than this window's activations. */
export const recencyBand = (
  sessions: readonly HubSession[],
  size: number = BAND_SIZE,
): HubSession[] =>
  [...sessions].sort((x, y) => y.lastSeen.localeCompare(x.lastSeen)).slice(0, size);

/** Split the listing by what a click DOES: an open row activates its tab; an
 *  openable one becomes a new tab. */
export const openSplit = (
  sessions: readonly HubSession[],
  openKeys: readonly string[],
): { readonly open: HubSession[]; readonly openable: HubSession[] } => {
  const openSet = new Set(openKeys);
  return {
    open: sessions.filter((s) => openSet.has(s.artifact)),
    openable: sessions.filter((s) => !openSet.has(s.artifact)),
  };
};

/** Everything typing should be able to catch (D-020): the display title, the
 *  filename, the project's short name, and the full path. */
export const fuzzyValue = (s: HubSession): string =>
  `${sessionLabel(s)} ${s.name} ${projectName(s.project)} ${s.artifact}`;

/**
 * How well a row answers what was typed. 0 hides the row.
 *
 * cmdk's default scorer is a pure subsequence test, and the value it scores
 * here ends with an absolute path - so "taxes" matched
 * `Ar**t**if**a**ct-first: the ne**x**t Lucid mod**e**l …artifact-fir**s**t`,
 * five letters gathered from across a hundred characters, and the pick screen
 * offered an unrelated document while the session actually named "taxes" was
 * nowhere. Scattered letters are not a match; they are a coincidence that gets
 * likelier the longer the haystack.
 *
 * So: a contiguous hit always beats a split one, an earlier hit beats a later
 * one, and a subsequence only counts when it lands TIGHTLY - within a span a
 * few characters longer than the query itself. That keeps the abbreviations
 * worth having ("migplan" -> "Migration plan") and drops the coincidences.
 */
export const matchScore = (value: string, query: string): number => {
  const q = query.trim().toLowerCase();
  if (q === "") return 1;
  const v = value.toLowerCase();

  // Every whitespace-separated term must appear somehow: "tax check" should
  // find "2025 US tax checklist" without the two words being adjacent.
  const terms = q.split(/\s+/).filter((t) => t !== "");
  let total = 0;
  for (const term of terms) {
    const at = v.indexOf(term);
    if (at !== -1) {
      // Contiguous. A word boundary is what a human thinks they typed.
      const boundary = at === 0 || /[\s/\\._-]/.test(v[at - 1] ?? "");
      total += (boundary ? 100 : 60) + Math.max(0, 30 - at / 4);
      continue;
    }
    const tight = tightSubsequence(v, term);
    if (tight === 0) return 0;
    total += tight;
  }
  return total / terms.length;
};

/**
 * Score a subsequence match only if it is dense enough to be deliberate.
 *
 * Scans for the leftmost match, then measures the span it occupied: a query of
 * length n allowed to sprawl over 100 characters matches almost anything, so
 * the span is capped at a small multiple of the query and its tightness is the
 * score. Returns 0 when there is no match, or the match is too loose to be one.
 */
const tightSubsequence = (value: string, term: string): number => {
  let i = 0;
  let start = -1;
  let end = -1;
  for (let at = 0; at < value.length && i < term.length; at++) {
    if (value[at] === term[i]) {
      if (i === 0) start = at;
      end = at;
      i++;
    }
  }
  if (i < term.length) return 0;
  const span = end - start + 1;
  // Two characters of slack per typed character. "migplan" over "Migration
  // plan" spans 14 for 7 typed - inside the budget; "taxes" over a path spans
  // ~90 for 5 - nowhere near it.
  const budget = term.length * 2 + 4;
  if (span > budget) return 0;
  return Math.max(1, 40 - (span - term.length) * 3);
};
