import { parseHTML } from "linkedom";
import type { Anchor } from "../anchors/anchor.ts";
import { computeDomPath, computeFingerprint, type DomElementLike } from "../anchors/dom.ts";
import { escapeHtml } from "../core/escape.ts";
import type { DiffHunk, DiffResult } from "../protocol/wire.ts";

/**
 * Whole-DOM version diff (RFC §8, change view). Compares two artifact snapshots
 * and produces (1) an ordered list of change hunks for navigation/revert and
 * (2) a merged-diff HTML document that renders the change in place: added/
 * changed content marked for sage, removed content re-inserted as a struck
 * ghost in the gap it left. Element matching reuses the anchor stack
 * (data-lucid-id -> fingerprint), so wherever the agent left stable ids the
 * diff is exact, and it degrades to text matching otherwise.
 */

// The diff shapes are wire contract (src/protocol/wire.ts); re-exported here so
// server-side callers keep importing them from the module that computes them.
export type { DiffHunk, DiffResult, HunkKind } from "../protocol/wire.ts";

const BLOCK_SELECTOR =
  "h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,pre,figcaption,dt,dd,[data-lucid-id]";

const normalize = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

interface Block {
  readonly el: Element;
  readonly key: string; // lucidId, else fingerprint
  readonly text: string;
}

const blockKey = (el: Element): string => {
  const lucidId = el.getAttribute("data-lucid-id");
  if (lucidId) return `id:${lucidId}`;
  return `fp:${computeFingerprint(el as unknown as DomElementLike)}`;
};

const collectBlocks = (doc: Document): Block[] => {
  const out: Block[] = [];
  for (const el of Array.from(doc.querySelectorAll(BLOCK_SELECTOR))) {
    // Skip blocks that merely contain other collected blocks (e.g. a <ul> is not
    // collected, but its <li>s are; a <td> is, its container <tr> is via th/td).
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    out.push({ el, key: blockKey(el), text: normalize(el.textContent) });
  }
  return out;
};

const labelOf = (text: string): string =>
  text.length > 60 ? `${text.slice(0, 60)}…` : text || "(empty)";

const anchorOf = (el: Element, snippet: string): Anchor => {
  const lucidId = el.getAttribute("data-lucid-id");
  return {
    kind: "element",
    ...(lucidId ? { lucidId } : {}),
    fingerprint: computeFingerprint(el as unknown as DomElementLike),
    domPath: computeDomPath(el as unknown as DomElementLike),
    snippet: snippet.slice(0, 400),
  };
};

/** Token-level LCS diff -> inline <del>/<ins> redline markup (escaped). */
const wordRedline = (oldText: string, newText: string): string => {
  const a = oldText.match(/\S+|\s+/g) ?? [];
  const b = newText.match(/\S+|\s+/g) ?? [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  const parts: string[] = [];
  let del: string[] = [];
  let ins: string[] = [];
  const flush = (): void => {
    if (del.length) parts.push(`<del class="lucid-del">${escapeHtml(del.join(""))}</del>`);
    if (ins.length) parts.push(`<ins class="lucid-ins">${escapeHtml(ins.join(""))}</ins>`);
    del = [];
    ins = [];
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      parts.push(escapeHtml(a[i]!));
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      del.push(a[i]!);
      i++;
    } else {
      ins.push(b[j]!);
      j++;
    }
  }
  while (i < n) del.push(a[i++]!);
  while (j < m) ins.push(b[j++]!);
  flush();
  return parts.join("");
};

/** Jaccard word-set overlap, for pairing an edited block to its prior self. */
const similarity = (a: string, b: string): number => {
  const sa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
};

export const diffHtml = (
  baseHtml: string,
  currentHtml: string,
  base: number,
  current: number,
): DiffResult => {
  const baseDoc = parseHTML(baseHtml).document;
  const mergedDoc = parseHTML(currentHtml).document;

  const baseBlocks = collectBlocks(baseDoc);
  const currentBlocks = collectBlocks(mergedDoc as unknown as Document);

  // Index base blocks by key and by text for matching.
  const baseByKey = new Map<string, Block>();
  const baseByText = new Map<string, Block>();
  for (const b of baseBlocks) {
    if (!baseByKey.has(b.key)) baseByKey.set(b.key, b);
    if (b.text && !baseByText.has(b.text)) baseByText.set(b.text, b);
  }
  const matchedBaseKeys = new Set<string>();
  const hunks: DiffHunk[] = [];
  let hunkSeq = 0;
  const nextId = (): string => `h${++hunkSeq}`;

  const markChanged = (cb: Block, from: Block): void => {
    const id = nextId();
    // Capture the anchor snippet from the CURRENT element's original markup
    // BEFORE redline injection, so the revert payload carries the artifact's
    // authored HTML rather than Lucid's <del>/<ins> redline markup.
    const snippet = cb.el.outerHTML ?? cb.text;
    cb.el.setAttribute("data-hunk", id);
    cb.el.setAttribute("data-diff", "changed");
    cb.el.classList.add("lucid-changed");
    cb.el.innerHTML = wordRedline(from.text, cb.text);
    hunks.push({
      id,
      kind: "changed",
      label: labelOf(cb.text),
      anchor: anchorOf(cb.el, snippet),
    });
  };
  const markAdded = (cb: Block): void => {
    const id = nextId();
    const snippet = cb.el.outerHTML ?? cb.text;
    cb.el.setAttribute("data-hunk", id);
    cb.el.setAttribute("data-diff", "added");
    cb.el.classList.add("lucid-added");
    hunks.push({
      id,
      kind: "added",
      label: labelOf(cb.text),
      anchor: anchorOf(cb.el, snippet),
    });
  };

  // Pass 1: exact matches (same key+text -> unchanged; same lucidId, different
  // text -> changed). Leftovers fall to the similarity pass.
  const currentLeft: Block[] = [];
  for (const cb of currentBlocks) {
    const byKey = baseByKey.get(cb.key);
    if (byKey && byKey.text === cb.text) {
      matchedBaseKeys.add(byKey.key);
      continue; // unchanged
    }
    if (byKey && cb.key.startsWith("id:")) {
      matchedBaseKeys.add(byKey.key);
      markChanged(cb, byKey);
      continue;
    }
    const byText = cb.text ? baseByText.get(cb.text) : undefined;
    if (byText && !matchedBaseKeys.has(byText.key)) {
      matchedBaseKeys.add(byText.key);
      continue; // unchanged (moved-but-identical text)
    }
    currentLeft.push(cb);
  }

  // Pass 2: pair leftover current blocks with leftover base blocks by
  // tag + word similarity -> a text edit. Otherwise the current block is added.
  const baseLeft = baseBlocks.filter((b) => !matchedBaseKeys.has(b.key));
  const baseAvailable = new Set(baseLeft);
  for (const cb of currentLeft) {
    let best: Block | undefined;
    let bestScore = 0;
    for (const bb of baseAvailable) {
      if (bb.el.tagName !== cb.el.tagName) continue;
      const score = similarity(bb.text, cb.text);
      if (score > bestScore) {
        bestScore = score;
        best = bb;
      }
    }
    if (best && bestScore >= 0.3) {
      baseAvailable.delete(best);
      matchedBaseKeys.add(best.key);
      markChanged(cb, best);
    } else {
      markAdded(cb);
    }
  }

  // Removed base blocks: re-insert ghosts where they lived.
  for (let bi = 0; bi < baseBlocks.length; bi++) {
    const bb = baseBlocks[bi]!;
    if (matchedBaseKeys.has(bb.key)) continue;
    // Skip if another removed block already covered this text (dup).
    const id = nextId();
    const ghost = mergedDoc.createElement(bb.el.tagName.toLowerCase());
    ghost.setAttribute("data-hunk", id);
    ghost.setAttribute("data-diff", "removed");
    ghost.setAttribute("class", "lucid-ghost");
    ghost.textContent = bb.text;
    // Find a surviving predecessor to anchor the ghost after.
    let anchorEl: Element | null = null;
    for (let k = bi - 1; k >= 0; k--) {
      const prev = baseBlocks[k]!;
      if (matchedBaseKeys.has(prev.key)) {
        anchorEl = findCurrentByKeyOrText(mergedDoc as unknown as Document, prev);
        if (anchorEl) break;
      }
    }
    if (anchorEl?.parentNode) {
      anchorEl.parentNode.insertBefore(ghost, anchorEl.nextSibling);
    } else {
      mergedDoc.body.insertBefore(ghost, mergedDoc.body.firstChild);
    }
    hunks.push({
      id,
      kind: "removed",
      label: labelOf(bb.text),
      anchor: anchorOf(bb.el, bb.el.outerHTML ?? bb.text),
    });
  }

  return {
    base,
    current,
    changed: hunks.length > 0,
    hunks,
    mergedHtml: mergedDoc.body.innerHTML,
  };
};

const findCurrentByKeyOrText = (doc: Document, b: Block): Element | null => {
  for (const el of Array.from(doc.querySelectorAll(BLOCK_SELECTOR))) {
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    if (blockKey(el) === b.key || normalize(el.textContent) === b.text) return el;
  }
  return null;
};
