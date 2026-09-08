/**
 * A DOM for the tests that need one.
 *
 * Anchoring is browser code: it parses a document, walks it, and searches
 * its text with a library that builds Ranges. Proving it needs a DOM, and
 * `bun test` has none.
 *
 * jsdom rather than a lighter one: `dom-anchor-text-quote` builds Ranges
 * across text nodes, and the lighter DOM's Range refused the boundary
 * points the library sets. A test environment that rejects valid input
 * would have proven nothing about the code under test.
 */
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");

for (const name of ["DOMParser", "Node", "Range", "NodeFilter", "Document", "Element"] as const) {
  if ((globalThis as Record<string, unknown>)[name] === undefined) {
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[
      name
    ];
  }
}
