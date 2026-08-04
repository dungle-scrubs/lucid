import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { rangeTextNode, resolveRangeOffsets } from "../src/anchors/dom.ts";
import type { DomRootLike } from "../src/anchors/dom.ts";
import type { RangeAnchor } from "../src/anchors/anchor.ts";
import { offsetWithin } from "../client/shared/capture.ts";

/**
 * plan 04, M1.2: capture and resolve must measure range-anchor offsets against
 * the SAME text node. `rangeTextNode` (dom.ts) already owns the rule on the
 * resolve side; capture used to hardcode `document.body`, so a document with an
 * empty body but text in `documentElement` captured offsets resolve could not
 * match. `offsetWithin` walks whatever `rangeTextNode` picks, so the two sides
 * agree by construction.
 */

const doc = (html: string): DomRootLike => parseHTML(html).document as unknown as DomRootLike;

describe("offsetWithin + resolveRangeOffsets agree on rangeTextNode", () => {
  test("an empty-body document whose text lives in documentElement (the M1.2 defect)", () => {
    // Body is empty; the only text is in <head><title>, so rangeTextNode returns
    // documentElement. Capture must measure there too, or resolve (which always
    // has) cannot match.
    const root = doc(
      "<!doctype html><html><head><title>Real title</title></head><body></body></html>",
    );
    const textRoot = rangeTextNode(root) as unknown as Node;
    expect(textRoot).toBe((root as unknown as { documentElement: Node }).documentElement);
    expect((root as unknown as { body: Node }).body.textContent ?? "").toBe("");

    // The title's text node, found the way a Selection would hand it to capture.
    const titleText = (
      root.querySelector("title") as unknown as {
        childNodes: NodeListOf<Node>;
      }
    ).childNodes[0] as Node;
    expect(titleText.nodeType).toBe(3);

    const exact = titleText.textContent ?? "";
    const start = offsetWithin(textRoot, titleText, 0);
    const end = start + exact.length;

    // Capture's offsets are measured against rangeTextNode's text - the same
    // text resolve scans - so the round-trip lands exactly.
    const anchor: RangeAnchor = {
      kind: "range",
      quote: { exact, prefix: "", suffix: "" },
      position: { start, end },
      snippet: exact.slice(0, 2000),
    };
    const located = resolveRangeOffsets(anchor, root);
    expect(located).not.toBeNull();
    expect(located).toEqual({ start, end, match: "exact" });
  });

  test("an ordinary body-text document still captures against the body", () => {
    // The common shape does not regress: rangeTextNode returns <body>, and the
    // offsets land in body text.
    const root = doc(
      "<!doctype html><html><body><p>The target phrase sits here.</p></body></html>",
    );
    const textRoot = rangeTextNode(root) as unknown as Node;
    expect(textRoot).toBe((root as unknown as { body: Node }).body);

    const phrase = (
      root.querySelectorAll("p")[0] as unknown as {
        childNodes: NodeListOf<Node>;
      }
    ).childNodes[0] as unknown as Node;
    expect(phrase.nodeType).toBe(3);
    const exact = phrase.textContent ?? "";
    const start = offsetWithin(textRoot, phrase, 0);
    const anchor: RangeAnchor = {
      kind: "range",
      quote: { exact, prefix: "", suffix: "" },
      position: { start, end: start + exact.length },
      snippet: exact.slice(0, 2000),
    };
    expect(resolveRangeOffsets(anchor, root)).toEqual({
      start,
      end: start + exact.length,
      match: "exact",
    });
  });
});
