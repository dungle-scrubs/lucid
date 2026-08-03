import type { Anchor, ElementAnchor, RangeAnchor } from "../../src/anchors/anchor.ts";
import { decisionAncestor } from "./decision.ts";
import {
  captureElementAnchor,
  type DomElementLike,
  type DomRootLike,
  rangeTextNode,
  resolveElementAnchor,
  resolveRangeOffsets,
} from "../../src/anchors/dom.ts";

const CONTEXT_LEN = 32;

/** Character offset of (node, offset) within document.body.textContent. */
const offsetInBody = (node: Node, nodeOffset: number): number => {
  const body = document.body;
  // Text node: offset is a character offset.
  if (node.nodeType === Node.TEXT_NODE) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let total = 0;
    let current = walker.nextNode();
    while (current) {
      if (current === node) return total + nodeOffset;
      total += current.textContent?.length ?? 0;
      current = walker.nextNode();
    }
    return total;
  }
  // Element node: offset is a child index. Walk text up to (not including) the
  // child at that index, so the position lands at the start of that subtree.
  if (node.nodeType === Node.ELEMENT_NODE && body.contains(node)) {
    const child = node.childNodes[nodeOffset];
    if (!child) return textLengthOf(node);
    return textLengthBefore(child);
  }
  return 0;
};

/** Total character length of all text descendants of a node. */
const textLengthOf = (node: Node): number => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return total;
};

/** Character offset of `target` within document.body.textContent. */
const textLengthBefore = (target: Node): number => {
  const body = document.body;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === target) return total;
    // `target` may be an element whose first text node is `current`'s successor.
    if (target.contains(current) === false && current.contains(target)) return total;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
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

/**
 * The marked decision a picked element belongs to, as an anchor - the element
 * itself when it is marked, else its nearest marked ancestor. Undefined when
 * the pick is not inside one.
 */
export const captureDecision = (el: Element | null): ElementAnchor | undefined => {
  const found = decisionAncestor(el);
  return found ? captureElement(found) : undefined;
};

/** The decision a text selection sits inside: walked from the range's own
 *  container, so selecting a phrase inside a recommendation still finds it. */
export const captureSelectionDecision = (): ElementAnchor | undefined => {
  const range = window.getSelection()?.getRangeAt(0);
  if (!range) return undefined;
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return captureDecision(el);
};

/** Resolve an element anchor to a live element in the current document. */
export const resolveElementInDocument = (anchor: ElementAnchor): Element | null =>
  resolveElementAnchor(anchor, document as unknown as DomRootLike) as unknown as Element | null;

/**
 * Resolve a range anchor to a live Range in the current document, or null.
 *
 * The locating is `resolveRangeOffsets`' - one scan of the document text,
 * against the same node the server measured the offsets in (#11). Only the
 * offsets -> Range walk stays here: it needs the browser's Range API, which
 * the shared resolver cannot have.
 */
export const resolveRangeInDocument = (anchor: RangeAnchor): Range | null => {
  const root = document as unknown as DomRootLike;
  const located = resolveRangeOffsets(anchor, root);
  if (!located) return null;
  return rangeFromTextOffsets(rangeTextNode(root) as unknown as Node, located.start, located.end);
};

/** Build a DOM Range from character offsets into `textRoot`'s textContent. */
const rangeFromTextOffsets = (textRoot: Node, start: number, end: number): Range | null => {
  const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
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
