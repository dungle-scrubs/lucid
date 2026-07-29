import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
  captureElementAnchor,
  anchorMatch,
  anchorResolves,
  resolveElementAnchor,
  resolveElementMatch,
} from "../src/anchors/dom.ts";
import type { DomElementLike, DomRootLike } from "../src/anchors/dom.ts";
import type { Anchor } from "../src/anchors/anchor.ts";

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

// --- M2.1: the confidence tag -------------------------------------------

describe("resolveElementMatch: how sure the resolution is (plan 05, M2.1, D-007)", () => {
  const root = (html: string): DomRootLike => parseHTML(html).document as unknown as DomRootLike;

  test("a data-lucid-id match is EXACT", () => {
    const src = root(`<body><p data-lucid-id="claim">the claim</p></body>`);
    const anchor = captureElementAnchor(src.querySelectorAll("p")[0] as DomElementLike);
    // A re-render that moved and reworded everything else: the id still names it.
    const after = root(`<body><h1>new</h1><p data-lucid-id="claim">reworded claim</p></body>`);
    const m = resolveElementMatch(anchor, after);
    expect(m?.match).toBe("exact");
    expect(m?.el.textContent).toBe("reworded claim");
  });

  test("a unique fingerprint match is EXACT", () => {
    const src = root(`<body><ol><li>alpha</li><li>target row</li></ol></body>`);
    const anchor = captureElementAnchor(src.querySelectorAll("li")[1] as DomElementLike);
    // Ancestor restructured, so the domPath is stale; the fingerprint is unique.
    const after = root(`<body><ul><li>alpha</li><li>target row</li></ul></body>`);
    const m = resolveElementMatch(anchor, after);
    expect(m?.match).toBe("exact");
    expect(m?.el.textContent).toBe("target row");
  });

  test("a domPath fall-through is POSITIONAL - the honest floor of #47", () => {
    const src = root(`<body><ol><li>alpha</li><li>hydrated content</li></ol></body>`);
    const anchor = captureElementAnchor(src.querySelectorAll("li")[1] as DomElementLike);
    // The re-render has the same SHAPE but different content: no id, no
    // matching fingerprint - only the position lines up. That is a guess.
    const after = root(`<body><ol><li>alpha</li><li>something else entirely</li></ol></body>`);
    const m = resolveElementMatch(anchor, after);
    expect(m?.match).toBe("positional");
    expect(m?.el.textContent).toBe("something else entirely");
  });

  test("no match at all is null, not a low-confidence guess", () => {
    const src = root(`<body><ol><li>alpha</li><li>gone</li></ol></body>`);
    const anchor = captureElementAnchor(src.querySelectorAll("li")[1] as DomElementLike);
    expect(resolveElementMatch(anchor, root(`<body><p>nothing alike</p></body>`))).toBeNull();
  });

  test("R1: the ELEMENT chosen is unchanged - the tag is additive", () => {
    const src = root(`<body><ol><li>alpha</li><li>beta</li><li>gamma</li></ol></body>`);
    for (const i of [0, 1, 2]) {
      const anchor = captureElementAnchor(src.querySelectorAll("li")[i] as DomElementLike);
      const after = root(`<body><ol><li>alpha</li><li>beta</li><li>gamma</li></ol></body>`);
      const tagged = resolveElementMatch(anchor, after)?.el ?? null;
      const plain = resolveElementAnchor(anchor, after);
      expect(tagged === plain).toBe(true);
    }
  });
});

describe("anchorMatch: confidence for BOTH anchor kinds (plan 05, M2.1, D-007)", () => {
  const root = (html: string): DomRootLike => parseHTML(html).document as unknown as DomRootLike;

  test("a range found in its quote context is EXACT", () => {
    const src = root(`<body><p>before the target text after</p></body>`);
    const anchor: Anchor = {
      kind: "range",
      quote: { exact: "target text", prefix: "before the ", suffix: " after" },
      position: { start: 11, end: 22 },
      snippet: "target text",
    };
    expect(anchorMatch(anchor, src)).toBe("exact");
  });

  /**
   * The quote context is what makes a range match trustworthy. When only the
   * character offsets line up, the surrounding words have changed - the same
   * string somewhere the author never pointed at. It resolves, and saying so
   * without qualification is the lie #47 is about.
   */
  test("a range that survives ONLY on character offsets is POSITIONAL", () => {
    const anchor: Anchor = {
      kind: "range",
      quote: { exact: "target text", prefix: "before the ", suffix: " after" },
      position: { start: 11, end: 22 },
      snippet: "target text",
    };
    // Same offsets, same exact text - but the context around it is gone. The
    // 11 leading characters put "target text" back at [11, 22) while neither
    // the prefix nor the suffix survives.
    const after = root(`<body><p>ZZZZZZZZZZZtarget textZZZZZZ</p></body>`);
    expect(anchorMatch(anchor, after)).toBe("positional");
  });

  test("a range that resolves neither way is null", () => {
    const anchor: Anchor = {
      kind: "range",
      quote: { exact: "target text", prefix: "before the ", suffix: " after" },
      position: { start: 11, end: 22 },
      snippet: "target text",
    };
    expect(anchorMatch(anchor, root(`<body><p>nothing alike at all</p></body>`))).toBeNull();
  });

  test("an element anchor reports the same tag anchorMatch as resolveElementMatch", () => {
    const src = root(`<body><ol><li>alpha</li><li>hydrated content</li></ol></body>`);
    const anchor = captureElementAnchor(src.querySelectorAll("li")[1] as DomElementLike);
    const after = root(`<body><ol><li>alpha</li><li>something else entirely</li></ol></body>`);
    expect(anchorMatch(anchor, after)).toBe(resolveElementMatch(anchor, after)?.match ?? null);
  });

  test("R1: anchorResolves agrees with anchorMatch everywhere - the tag is additive", () => {
    const src = root(`<body><ol><li>alpha</li><li>beta</li></ol></body>`);
    const anchor = captureElementAnchor(src.querySelectorAll("li")[1] as DomElementLike);
    for (const html of [
      `<body><ol><li>alpha</li><li>beta</li></ol></body>`,
      `<body><ol><li>alpha</li><li>changed</li></ol></body>`,
      `<body><p>nothing alike</p></body>`,
    ]) {
      const after = root(html);
      expect(anchorResolves(anchor, after)).toBe(anchorMatch(anchor, after) !== null);
    }
  });
});
