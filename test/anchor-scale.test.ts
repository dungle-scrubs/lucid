import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { captureElementAnchor, resolveElementAnchor } from "../src/anchors/dom.ts";
import type { DomElementLike, DomRootLike } from "../src/anchors/dom.ts";

/**
 * Sibling fan-out is the trigger, not bytes (plan 04, M1.2, #46 / D-065):
 * resolution's fingerprint layer computed each element's sibling index by
 * scanning its parent's children, which on a flat 18k-sibling list went
 * super-quadratic - the committed card never rendered and `lucid wait` hung.
 * The index is one pass now; this asserts COMPLETION on the hostile shape
 * (a timeout is the red), not a wall-clock number.
 */

const FLAT = 18_000;

test(
  "18k flat siblings capture and resolve in one pass",
  () => {
    const rows = Array.from({ length: FLAT }, (_, i) => `<li>row ${i}</li>`).join("");
    const html = `<!doctype html><html><body><ol>${rows}</ol></body></html>`;

    const doc = parseHTML(html).document as unknown as DomRootLike;
    const target = doc.querySelectorAll("li")[17_442] as DomElementLike;
    const anchor = captureElementAnchor(target);

    const reRender = parseHTML(html).document as unknown as DomRootLike;
    const match = resolveElementAnchor(anchor, reRender);
    expect(match?.textContent).toBe("row 17442");
  },
  { timeout: 20_000 },
);
