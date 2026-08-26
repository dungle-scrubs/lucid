/**
 * Finding a spot again after the agent has rewritten the document.
 *
 * A note is written against one version. The agent then writes more,
 * without knowing the note exists. The spot it pointed at may be reworded,
 * moved, or gone.
 *
 * Per spot, three ways of finding it are written when the note is made, and
 * tried in order:
 *
 * 1. **TextQuoteSelector** — the text, with what came before and after.
 *    Matched approximately, because an exact match alone misses whenever
 *    the agent changes a word, and against a document the agent rewrites
 *    that is the common case rather than the exception.
 * 2. **TextPositionSelector** — where in the document's text it sat.
 * 3. **CssSelector** — a path to the element.
 *
 * The approximate search is `dom-anchor-text-quote`. It is not written
 * here: a hand-rolled fuzzy match is the part of this that is easy to get
 * subtly wrong and hard to notice.
 *
 * Two rules that decide what this does NOT do:
 *
 * - **A layer that matches twice is discarded, not guessed at.** Falling
 *   through to a less durable layer is better than pointing a note at the
 *   wrong paragraph confidently.
 * - **The version the note was made against is verified by hash first.**
 *   The selectors describe those bytes. If the bytes cannot be verified,
 *   nothing is re-anchored and the note stays where it was — it is never
 *   re-pointed at whatever now occupies that space.
 *
 * `refinedBy` is not used. It nests one selector inside another; these
 * three are alternatives for one spot.
 */
import { toRange } from "dom-anchor-text-quote";

/** The three ways of finding a spot, written at annotation time against the
 * version being annotated. */
export interface SpotSelectors {
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly position: { readonly start: number; readonly end: number };
  readonly css: string;
}

/** How confidently a spot re-attached. Reported, never inferred from the
 * fact that something was found. */
export type Confidence = "exact" | "approximate" | "position" | "css";

export type Resolution =
  | { readonly resolved: true; readonly elementId: string; readonly how: Confidence }
  | { readonly resolved: false; readonly why: "not-found" | "ambiguous" | "unverified-source" };

/** lucid's element ids, assigned the same way the injected script assigns
 * them: document order over everything inside body, `e` + a counter. The
 * frame and this must agree, or an id resolved here would name a different
 * element there. */
export const elementIds = (doc: Document): Element[] =>
  doc.body === null ? [] : [...doc.body.querySelectorAll("*")];

const idOf = (all: readonly Element[], el: Element | null): string | null => {
  if (el === null) return null;
  const at = all.indexOf(el);
  return at === -1 ? null : `e${at + 1}`;
};

/** The element an id names, in this document. */
export const elementFor = (doc: Document, elementId: string): Element | null => {
  const at = Number(elementId.slice(1));
  if (!Number.isSafeInteger(at) || at < 1) return null;
  return elementIds(doc)[at - 1] ?? null;
};

/** An element's text as the document actually holds it. Not normalised:
 * the quote search runs over the document's own text, so a selector built
 * from a tidied copy would not match the thing it was built from. */
const textOf = (el: Element): string => el.textContent ?? "";

/** A CSS path to an element: tag plus nth-of-type at every step. Not the
 * document's own ids or classes — the agent may reuse, drop, or rename
 * either between versions, and a path built from them looks stable while
 * silently pointing somewhere else. */
const cssPath = (el: Element): string => {
  const steps: string[] = [];
  let node: Element | null = el;
  while (node !== null && node.tagName.toLowerCase() !== "body") {
    const parent: Element | null = node.parentElement;
    if (parent === null) break;
    const tag = node.tagName.toLowerCase();
    const sameTag = [...parent.children].filter((c) => c.tagName === node?.tagName);
    const at = sameTag.indexOf(node) + 1;
    steps.unshift(sameTag.length === 1 ? tag : `${tag}:nth-of-type(${at})`);
    node = parent;
  }
  return `body > ${steps.join(" > ")}`;
};

/** Write the three selectors for a spot, against the document it was
 * annotated in. */
export const selectorsFor = (doc: Document, elementId: string): SpotSelectors | null => {
  const el = elementFor(doc, elementId);
  if (el === null) return null;
  const whole = doc.body?.textContent ?? "";
  const exact = textOf(el);
  const start = exact === "" ? -1 : whole.indexOf(exact);
  return {
    quote: around(whole, start, exact),
    position: { start: Math.max(0, start), end: Math.max(0, start) + exact.length },
    css: cssPath(el),
  };
};

/** Enough context to tell two identical passages apart, and not so much
 * that rewriting a neighbour breaks the anchor. Shared by both builders so a
 * whole-element spot and a selected-text spot are measured the same way. */
const CONTEXT = 32;

const around = (whole: string, start: number, exact: string): SpotSelectors["quote"] => ({
  exact,
  prefix: start <= 0 ? "" : whole.slice(Math.max(0, start - CONTEXT), start),
  suffix: start < 0 ? "" : whole.slice(start + exact.length, start + exact.length + CONTEXT),
});

/**
 * The three selectors for a spot that is SOME of an element's text rather
 * than all of it: what a person selected with the cursor.
 *
 * Offsets are measured here, against the document's own bytes, and never
 * taken from the browser frame. The frame's copy carries lucid's injected
 * `<style>` and `<script>`, and both contribute to `textContent`, so an
 * offset captured there is shifted by however long lucid's own source
 * happens to be.
 *
 * `exact` can occur more than once in a document. The occurrence inside
 * `elementId` is the one the person selected, so the search starts there and
 * the offset is translated into the whole document. Falling back to the
 * first occurrence anywhere would silently anchor a note to a different
 * paragraph that happens to share a word.
 */
export const selectorsForQuote = (
  doc: Document,
  elementId: string,
  exact: string,
): SpotSelectors | null => {
  const el = elementFor(doc, elementId);
  if (el === null || exact === "") return null;
  const whole = doc.body?.textContent ?? "";
  const inner = textOf(el);
  const within = inner.indexOf(exact);
  // Selected text that is not in the element it was reported against. The
  // element wins: an anchor into text nobody selected is worse than one that
  // covers more than they meant.
  if (within === -1) return selectorsFor(doc, elementId);
  const elementAt = whole.indexOf(inner);
  const start = elementAt === -1 ? whole.indexOf(exact) : elementAt + within;
  if (start === -1) return selectorsFor(doc, elementId);
  return {
    quote: around(whole, start, exact),
    position: { start, end: start + exact.length },
    // The same element path as a whole-element spot. It is the last resort
    // in resolution, and at that point the element is all that is left to
    // point at anyway.
    css: cssPath(el),
  };
};

/** Which element a range landed in.
 *
 * Not the common ancestor: a range whose two boundaries sit on different
 * nodes has body as its ancestor, which names no spot. Where the range
 * STARTS is the element the quote was found in. */
const elementOfRange = (range: Range): Element | null => {
  const node = range.startContainer;
  if (node.nodeType === 3) return node.parentElement;
  const el = node as Element;
  const child = el.childNodes[range.startOffset];
  if (child === undefined) return el;
  if (child.nodeType === 3) return child.parentElement;
  return child.nodeType === 1 ? (child as Element) : el;
};

/** Count how many times a string occurs, so a layer that matches twice can
 * be discarded rather than guessed at. This is an ambiguity check, not a
 * search — the search is the library's. */
const occurrences = (haystack: string, needle: string): number => {
  if (needle === "") return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && n < 3) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
};

/** Ask the library where the quote is, three ways.
 *
 * The prefix is searched first and used to place the search. That helps
 * when the surroundings survived and hurts when they did not: a prefix
 * that still exists somewhere unrelated drags the search there and the
 * match fails against text that was sitting right where it always was. So
 * a failure with both hints is retried with the suffix alone, and then
 * with neither.
 *
 * Each attempt is the library's search. None of it is a second matcher. */
const quoteIn = (root: Element, quote: SpotSelectors["quote"]): Element | null => {
  const attempts = [quote, { exact: quote.exact, suffix: quote.suffix }, { exact: quote.exact }];
  for (const attempt of attempts) {
    try {
      const range = toRange(root, attempt);
      if (range !== null && range.toString().trim() !== "") return elementOfRange(range);
    } catch {
      // The library walks off the end of some documents rather than
      // returning null. That is this attempt failing, not the resolution.
    }
  }
  return null;
};

/** Find a spot in a document it was not written against.
 *
 * `verified` is the snapshot guard's answer: whether the version the note
 * was made against still hashes to what it did. False means nothing is
 * re-anchored, whatever the selectors would have said. */
export const resolveSpot = (
  target: Document,
  selectors: SpotSelectors,
  verified: boolean,
): Resolution => {
  if (!verified) return { resolved: false, why: "unverified-source" };
  const all = elementIds(target);
  const root = target.body;
  if (root === null) return { resolved: false, why: "not-found" };
  const whole = root.textContent ?? "";

  // 1. The quote. The most durable of the three, because it matches
  //    approximately: a reworded sentence is still found, where an exact
  //    match would miss.
  const { exact } = selectors.quote;
  if (exact !== "") {
    const seen = occurrences(whole, exact);
    if (seen < 2) {
      const found = quoteIn(root, selectors.quote);
      if (found !== null) {
        const id = idOf(all, found);
        if (id !== null) {
          // Verbatim and unique, or found by approximation. A caller can
          // tell a confident match from a hopeful one.
          return { resolved: true, elementId: id, how: seen === 1 ? "exact" : "approximate" };
        }
      }
    }
    // The same text twice over and the context did not separate them: fall
    // through rather than pick one.
  }

  // 2. Where it sat in the text — and only if the same text is still
  //    there. Without that check this layer points the note at whatever now
  //    occupies the offset, which is the one thing a lost anchor must never
  //    do: a note would silently become a note about a paragraph its author
  //    never saw. Checked, it answers the case the quote search struggles
  //    with — an unchanged document with the same text in two places, where
  //    the offset is what separates them.
  const { start, end } = selectors.position;
  if (start >= 0 && end > start && end <= whole.length && whole.slice(start, end) === exact) {
    let walked = 0;
    for (const el of all) {
      if (el.children.length > 0) continue;
      const t = el.textContent ?? "";
      if (start >= walked && start < walked + t.length) {
        const id = idOf(all, el);
        if (id !== null) return { resolved: true, elementId: id, how: "position" };
      }
      walked += t.length;
    }
  }

  // 3. The path — and only if what it finds is still recognisably the
  //    thing that was annotated.
  //
  //    A path names a position in the structure, not a thing. `p:nth-of-type(1)`
  //    matches whatever the first paragraph now is, so accepting it on its
  //    own re-points the note at whatever took that place — the one thing a
  //    lost anchor must never do. So the path locates a candidate and the
  //    quote confirms it, scoped to that element.
  try {
    const found = target.querySelectorAll(selectors.css);
    if (found.length > 1) return { resolved: false, why: "ambiguous" };
    const one = found[0];
    if (one !== undefined && quoteIn(one, selectors.quote) !== null) {
      const id = idOf(all, one);
      if (id !== null) return { resolved: true, elementId: id, how: "css" };
    }
  } catch {
    // A path that will not parse is a failed layer, not a crash.
  }

  return { resolved: false, why: "not-found" };
};

/** SHA-256 of the bytes, hex — the same digest the store writes, so a
 * version can be verified in the browser without trusting the server to
 * have checked. */
export const sha256Hex = async (bytes: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
