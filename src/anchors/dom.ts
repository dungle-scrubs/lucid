import type { Anchor, ElementAnchor, RangeAnchor } from "./anchor.ts";

/**
 * Shared anchor capture/resolution logic that operates against a minimal
 * structural DOM interface, so the SAME code runs in the browser (real DOM
 * during capture and live re-anchoring) and server-side (linkedom DOM during
 * `wait` payload resolution). This is the single source of truth for the
 * fingerprint and DOM-path algorithms - they MUST be identical on both sides or
 * an anchor captured in the browser would not re-resolve on the server.
 */

export interface DomElementLike {
  readonly tagName: string;
  readonly id?: string;
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  readonly outerHTML?: string;
  readonly parentElement: DomElementLike | null;
  readonly children: ArrayLike<DomElementLike>;
}

export interface DomRootLike {
  querySelector(selector: string): DomElementLike | null;
  querySelectorAll(selector: string): ArrayLike<DomElementLike>;
  readonly body?: { readonly textContent: string | null } | null;
  readonly documentElement?: { readonly textContent: string | null } | null;
  readonly textContent?: string | null;
}

const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Deterministic 4-hex FNV-1a hash; identical output in browser and Node. */
const shortHash = (s: string): string => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).slice(0, 4).padStart(4, "0");
};

const PREVIEW_LEN = 24;

/** Content + structure fingerprint, e.g. `li#a3f9·"Backfill from…"`. */
export const computeFingerprint = (el: DomElementLike): string => {
  const tag = el.tagName.toLowerCase();
  const text = normalizeText(el.textContent ?? "");
  const hash = shortHash(`${tag}|${text}`);
  const preview = text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
  return `${tag}#${hash}·"${preview}"`;
};

const indexAmongSiblings = (el: DomElementLike): number => {
  const parent = el.parentElement;
  if (!parent) return 1;
  let n = 0;
  for (let i = 0; i < parent.children.length; i++) {
    n += 1;
    if (parent.children[i] === el) return n;
  }
  return n;
};

/** Structural CSS path from the document body, e.g. `article>ol>li:nth-child(2)`. */
export const computeDomPath = (el: DomElementLike): string => {
  const segments: string[] = [];
  let current: DomElementLike | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === "body" || tag === "html") break;
    segments.unshift(`${tag}:nth-child(${indexAmongSiblings(current)})`);
    current = current.parentElement;
  }
  return segments.join(">");
};

/** Capture a full element anchor from a target element. */
export const captureElementAnchor = (el: DomElementLike): ElementAnchor => {
  const lucidId = el.getAttribute("data-lucid-id");
  return {
    kind: "element",
    ...(lucidId ? { lucidId } : {}),
    fingerprint: computeFingerprint(el),
    domPath: computeDomPath(el),
    snippet: (el.outerHTML ?? el.textContent ?? "").slice(0, 2000),
  };
};

const toArray = (a: ArrayLike<DomElementLike>): DomElementLike[] => Array.from(a);

/**
 * Resolve an element anchor against a root, in priority order
 * lucidId -> fingerprint -> domPath (D-047). Returns the matched element or
 * null. A `data-lucid-id` that is not unique within the document is skipped
 * (falls through to fingerprint) per D-047.
 */
export const resolveElementAnchor = (
  anchor: ElementAnchor,
  root: DomRootLike,
): DomElementLike | null => {
  if (anchor.lucidId) {
    const matches = toArray(
      root.querySelectorAll(`[data-lucid-id="${cssEscape(anchor.lucidId)}"]`),
    );
    if (matches.length === 1 && matches[0]) return matches[0];
    // non-unique -> skip lucidId layer
  }

  const byFingerprint = toArray(root.querySelectorAll("*")).find(
    (el) => computeFingerprint(el) === anchor.fingerprint,
  );
  if (byFingerprint) return byFingerprint;

  if (anchor.domPath) {
    try {
      const match = root.querySelector(anchor.domPath);
      if (match) return match;
    } catch {
      // invalid selector -> no match
    }
  }
  return null;
};

const cssEscape = (s: string): string => s.replace(/["\\]/g, "\\$&");

const rootText = (root: DomRootLike): string => {
  const body = root.body?.textContent;
  if (body && body.length > 0) return body;
  const docEl = root.documentElement?.textContent;
  if (docEl && docEl.length > 0) return docEl;
  return root.textContent ?? "";
};

/**
 * Resolve a range anchor: quote (exact text in prefix/suffix context) first,
 * then character position (D-047). Returns true if it re-attaches.
 */
export const resolveRangeAnchor = (anchor: RangeAnchor, root: DomRootLike): boolean => {
  const text = rootText(root);
  const { exact, prefix, suffix } = anchor.quote;

  if (exact.length > 0) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(exact, from);
      if (idx === -1) break;
      const before = text.slice(Math.max(0, idx - prefix.length), idx);
      const after = text.slice(idx + exact.length, idx + exact.length + suffix.length);
      const prefixOk = prefix.length === 0 || before.endsWith(prefix);
      const suffixOk = suffix.length === 0 || after.startsWith(suffix);
      if (prefixOk && suffixOk) return true;
      from = idx + 1;
    }
  }

  const { start, end } = anchor.position;
  if (start >= 0 && end <= text.length && start < end) {
    if (text.slice(start, end) === exact) return true;
  }
  return false;
};

/** Does this anchor re-attach to the given root? */
export const anchorResolves = (anchor: Anchor, root: DomRootLike): boolean => {
  if (anchor.kind === "element") return resolveElementAnchor(anchor, root) !== null;
  return resolveRangeAnchor(anchor, root);
};
