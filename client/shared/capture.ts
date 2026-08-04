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

// Stable DOM spec values, as locals rather than the `Node`/`NodeFilter` globals,
// so the offset helpers are unit-testable in a runtime with no DOM (bun:test).
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const SHOW_TEXT = 4;

/** Walk every text node under `root`, in document order. `ownerDocument` is
 *  the node's own document in a browser and the linkedom document in a unit
 *  test, so this helper is testable with no global DOM. */
const walkTextNodes = function* (root: Node): Generator<Node> {
  const owner = (root.ownerDocument ??
    (typeof document !== "undefined" ? document : null)) as Document | null;
  if (!owner) return;
  const walker = owner.createTreeWalker(root, SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    yield current;
    current = walker.nextNode();
  }
};

/** Total character length of all text descendants of `node`. */
const textLengthOf = (node: Node): number => {
  let total = 0;
  for (const text of walkTextNodes(node)) total += text.textContent?.length ?? 0;
  return total;
};

/** Character offset of `target` within `textRoot`'s text. `textRoot` is
 *  whichever node `rangeTextNode` picked - never a hardcoded `document.body`
 *  (plan 04, M1.2): the rule for WHICH node's text the offsets are measured
 *  against has one owner, and resolve already reads it. */
const textLengthBefore = (textRoot: Node, target: Node): number => {
  let total = 0;
  for (const current of walkTextNodes(textRoot)) {
    if (current === target) return total;
    // `target` may be an element whose first text node is `current`'s successor.
    if (target.contains(current) === false && current.contains(target)) return total;
    total += current.textContent?.length ?? 0;
  }
  return total;
};

/** Character offset of (container, offset) within `textRoot`'s text - the one
 *  measure both capture and resolve use (M1.2). `textRoot` is the node
 *  `rangeTextNode` chose, so capture never re-derives the root by a second
 *  rule. Exported so the capture/resolve agreement is unit-testable without a
 *  browser Selection. */
export const offsetWithin = (textRoot: Node, container: Node, offset: number): number => {
  // Text node: offset is a character offset into this node.
  if (container.nodeType === TEXT_NODE) {
    let total = 0;
    for (const current of walkTextNodes(textRoot)) {
      if (current === container) return total + offset;
      total += current.textContent?.length ?? 0;
    }
    return total;
  }
  // Element node: offset is a child index. Land at the start of that subtree:
  // the position is the text length before the child at that index.
  if (container.nodeType === ELEMENT_NODE && textRoot.contains(container)) {
    const child = (container as Element).childNodes[offset];
    if (!child) return textLengthOf(container);
    return textLengthBefore(textRoot, child);
  }
  return 0;
};

/** Capture a range anchor from the current selection, or undefined if none. */
export const captureRangeAnchor = (): RangeAnchor | undefined => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const exact = selection.toString();
  if (exact.trim().length === 0) return undefined;

  // Offsets are measured against whichever node `rangeTextNode` picks - the
  // same node resolve scans - never a hardcoded document.body (M1.2). An empty
  // body with text in documentElement otherwise captured offsets resolve could
  // not match.
  const textRoot = rangeTextNode(document as unknown as DomRootLike) as unknown as Node;
  const fullText = textRoot.textContent ?? "";
  const start = offsetWithin(textRoot, range.startContainer, range.startOffset);
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
