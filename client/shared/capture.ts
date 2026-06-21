import type { Anchor, ElementAnchor, RangeAnchor } from "../../src/anchors/anchor.ts";
import {
  captureElementAnchor,
  type DomElementLike,
  type DomRootLike,
  resolveElementAnchor,
  resolveRangeAnchor,
} from "../../src/anchors/dom.ts";

const CONTEXT_LEN = 32;

/** Character offset of (node, offset) within document.body.textContent. */
const offsetInBody = (node: Node, nodeOffset: number): number => {
  const body = document.body;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + nodeOffset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  // If the node is an element (offset is a child index), accumulate up to it.
  return total;
};

/** Capture a range anchor from the current selection, or undefined if none. */
export const captureRangeAnchor = (): RangeAnchor | undefined => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const exact = selection.toString();
  if (exact.trim().length === 0) return undefined;

  const fullText = document.body.textContent ?? "";
  const start = offsetInBody(range.startContainer, range.startOffset);
  const end = start + exact.length;
  const prefix = fullText.slice(Math.max(0, start - CONTEXT_LEN), start);
  const suffix = fullText.slice(end, end + CONTEXT_LEN);

  return {
    kind: "range",
    quote: { exact, prefix, suffix },
    position: { start, end },
    snippet: exact.slice(0, 2000),
  };
};

/** Capture an element anchor from a real DOM element. */
export const captureElement = (el: Element): ElementAnchor =>
  captureElementAnchor(el as unknown as DomElementLike);

/** Resolve an element anchor to a live element in the current document. */
export const resolveElementInDocument = (anchor: ElementAnchor): Element | null =>
  resolveElementAnchor(anchor, document as unknown as DomRootLike) as unknown as Element | null;

/** Resolve a range anchor to a live Range in the current document, or null. */
export const resolveRangeInDocument = (anchor: RangeAnchor): Range | null => {
  if (!resolveRangeAnchor(anchor, document as unknown as DomRootLike)) return null;
  const fullText = document.body.textContent ?? "";
  // Locate exact occurrence honoring prefix/suffix context.
  const { exact, prefix, suffix } = anchor.quote;
  let from = 0;
  let charStart = -1;
  for (;;) {
    const idx = fullText.indexOf(exact, from);
    if (idx === -1) break;
    const before = fullText.slice(Math.max(0, idx - prefix.length), idx);
    const after = fullText.slice(idx + exact.length, idx + exact.length + suffix.length);
    if (
      (prefix.length === 0 || before.endsWith(prefix)) &&
      (suffix.length === 0 || after.startsWith(suffix))
    ) {
      charStart = idx;
      break;
    }
    from = idx + 1;
  }
  if (charStart === -1) {
    if (
      anchor.position.start >= 0 &&
      fullText.slice(anchor.position.start, anchor.position.end) === exact
    ) {
      charStart = anchor.position.start;
    } else {
      return null;
    }
  }
  return rangeFromBodyOffsets(charStart, charStart + exact.length);
};

/** Build a DOM Range from character offsets into document.body.textContent. */
const rangeFromBodyOffsets = (start: number, end: number): Range | null => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let total = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (!startNode && total + len > start) {
      startNode = node;
      startOffset = start - total;
    }
    if (!endNode && total + len >= end) {
      endNode = node;
      endOffset = end - total;
      break;
    }
    total += len;
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
};

export type { Anchor };
