import type { Anchor, ElementAnchor, RangeAnchor } from "./anchor.ts";
import { tracer } from "../core/verbose.ts";

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

/**
 * Content + structure fingerprint, e.g. `li#a3f9·"Backfill from…"`. The hash
 * folds in the element's 1-based index among same-tag siblings so that two
 * siblings with identical tag + text (common: repeated placeholder rows,
 * identical status labels) still get distinct fingerprints; the human-readable
 * preview is unchanged.
 */
export const computeFingerprint = (el: DomElementLike, sibIndex?: number): string => {
  const tag = el.tagName.toLowerCase();
  const text = normalizeText(el.textContent ?? "");
  const hash = shortHash(`${tag}|${sibIndex ?? indexAmongSiblings(el)}|${text}`);
  const preview = text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
  return `${tag}#${hash}·"${preview}"`;
};

const indexAmongSiblings = (el: DomElementLike): number => {
  const parent = el.parentElement;
  if (!parent) return 1;
  // Materialize ONCE: some DOMs (linkedom) pay a list walk per `children`
  // access, which turns the innocent-looking indexed loop quadratic in the
  // sibling count for a single call (#46).
  const children = Array.from(parent.children);
  let n = 0;
  for (const child of children) {
    n += 1;
    if (child === el) return n;
  }
  return n;
};

/**
 * Sibling indices for a whole document in ONE pass (plan 04, M1.2, #46).
 * Computing each element's index by scanning its parent's children turns a
 * flat N-sibling list super-quadratic (N scans of N children, and a child
 * list some DOMs walk per access) - the shape that hung resolution on an 18k
 * sibling artifact. Here every parent's child list is walked exactly once,
 * so the whole map costs one traversal. The VALUES are identical to
 * `indexAmongSiblings` by construction: 1-based position among ALL siblings.
 */
const sibIndexMapOf = (elements: readonly DomElementLike[]): Map<DomElementLike, number> => {
  const map = new Map<DomElementLike, number>();
  const walked = new Set<DomElementLike>();
  for (const el of elements) {
    const parent = el.parentElement;
    if (!parent) {
      map.set(el, 1);
      continue;
    }
    if (walked.has(parent)) continue;
    walked.add(parent);
    const children = Array.from(parent.children);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) map.set(child, i + 1);
    }
  }
  return map;
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

/** Built once from the environment: a no-op unless `LUCID_VERBOSE` names
 *  `anchors`, so the silent default costs one call to an empty function. */
const anchorTrace = tracer("anchors");

/**
 * Resolve an element anchor against a root, in priority order
 * lucidId -> fingerprint -> domPath (D-047). Returns the matched element or
 * null. A layer whose match is not unique within the document is skipped and
 * falls through to the next (data-lucid-id -> fingerprint -> domPath) per
 * D-047; only the positional domPath is allowed to disambiguate.
 */
/**
 * How sure a resolution is (plan 05, M2.1, D-007).
 *
 * `exact` - a `data-lucid-id` or a UNIQUE fingerprint named this element: the
 * anchor found what it was pointing at.
 * `positional` - only the domPath matched, so the element is whatever now
 * occupies that slot. On a document whose real content is hydrated at runtime
 * (finding #47) that is a guess dressed as a match, and the difference is what
 * the low-confidence signal reports instead of lying.
 */
export type AnchorMatch = "exact" | "positional";

export interface ResolvedElement {
  readonly el: DomElementLike;
  readonly match: AnchorMatch;
}

/**
 * Resolve an element anchor against a root, in priority order
 * lucidId -> fingerprint -> domPath (D-047), reporting HOW it matched.
 * A layer whose match is not unique within the document is skipped and falls
 * through to the next per D-047; only the positional domPath is allowed to
 * disambiguate, and a match that only it could make is tagged `positional`.
 */
export interface ResolveOptions {
  /** Narrates WHICH layer matched and why the others were skipped (M3.1).
   *  Silent unless `LUCID_VERBOSE` names `anchors`; the default tracer is a
   *  no-op, so this path costs nothing when nobody asked. */
  readonly trace?: (message: () => string) => void;
}

/**
 * A fingerprint with its text preview removed: `p#a1b2·"Q3 layoffs: cut 40%…"`
 * becomes `p#a1b2`. The preview is REVIEW CONTENT (the element's own text),
 * and narration lands in an uncapped `server.out.log` at poll rate - the same
 * rule that keeps prompts and notes out of the request records applies to a
 * trace on disk (D-005). The hash still identifies the fingerprint uniquely,
 * which is what a human diagnosing a mismatch actually compares.
 */
const redactFingerprint = (fingerprint: string | undefined): string =>
  fingerprint === undefined ? "(none)" : fingerprint.replace(/·".*$/s, "");

export const resolveElementMatch = (
  anchor: ElementAnchor,
  root: DomRootLike,
  options: ResolveOptions = {},
): ResolvedElement | null => {
  const trace = options.trace ?? anchorTrace;
  if (anchor.lucidId) {
    const matches = toArray(
      root.querySelectorAll(`[data-lucid-id="${cssEscape(anchor.lucidId)}"]`),
    );
    if (matches.length === 1 && matches[0]) {
      trace(() => `lucidId "${anchor.lucidId}" -> 1 match, exact`);
      return { el: matches[0], match: "exact" };
    }
    // non-unique -> skip lucidId layer
    trace(
      () =>
        `lucidId "${anchor.lucidId}" -> ${matches.length} matches, skipped (a layer must be unique to win)`,
    );
  } else {
    trace(() => "lucidId absent on the anchor, skipped");
  }

  // One-pass sibling indices, then fingerprints over the map (#46): identical
  // values to the per-element scan, without the quadratic re-walk per element.
  const all = toArray(root.querySelectorAll("*"));
  const sibIndex = sibIndexMapOf(all);
  const byFingerprint = all.filter(
    (el) => computeFingerprint(el, sibIndex.get(el) ?? 1) === anchor.fingerprint,
  );
  // A unique fingerprint wins; a non-unique one is ambiguous (e.g. identical
  // status cells sharing a column position across table rows) and must fall
  // through to the positional domPath, same as the lucidId layer above.
  if (byFingerprint.length === 1 && byFingerprint[0]) {
    trace(() => `fingerprint ${redactFingerprint(anchor.fingerprint)} -> 1 match, exact`);
    return { el: byFingerprint[0], match: "exact" };
  }
  trace(
    () =>
      `fingerprint ${redactFingerprint(anchor.fingerprint)} -> ${byFingerprint.length} matches over ${all.length} elements, ` +
      `${byFingerprint.length === 0 ? "no match" : "ambiguous"}, falling through to domPath`,
  );

  if (anchor.domPath) {
    try {
      const match = root.querySelector(anchor.domPath);
      if (match) {
        trace(
          () =>
            `domPath "${anchor.domPath}" -> matched, POSITIONAL (whatever now occupies that slot)`,
        );
        return { el: match, match: "positional" };
      }
      trace(() => `domPath "${anchor.domPath}" -> no match`);
    } catch {
      // invalid selector -> no match
      trace(() => `domPath "${anchor.domPath}" -> invalid selector`);
    }
  } else {
    trace(() => "domPath absent on the anchor");
  }
  trace(() => "unresolved: no layer matched");
  return null;
};

/** The resolved element alone - the shape every existing caller wants. */
export const resolveElementAnchor = (
  anchor: ElementAnchor,
  root: DomRootLike,
): DomElementLike | null => resolveElementMatch(anchor, root)?.el ?? null;

const cssEscape = (s: string): string => s.replace(/["\\]/g, "\\$&");

const rootText = (root: DomRootLike): string => {
  const body = root.body?.textContent;
  if (body && body.length > 0) return body;
  const docEl = root.documentElement?.textContent;
  if (docEl && docEl.length > 0) return docEl;
  return root.textContent ?? "";
};

/**
 * Resolve a range anchor and say HOW it matched (plan 05, M2.1, D-007): quote
 * (exact text in prefix/suffix context) first, then character position
 * (D-047).
 *
 * The two are not equally trustworthy. The quote's prefix and suffix are what
 * tie the text to the spot the human pointed at; when only the offsets line up,
 * that context is gone and the same string now sits among different words. It
 * still resolves - and reporting that without qualification is exactly the lie
 * #47 is about - so the offset path is `positional`.
 */
export const resolveRangeMatch = (anchor: RangeAnchor, root: DomRootLike): AnchorMatch | null => {
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
      if (prefixOk && suffixOk) return "exact";
      from = idx + 1;
    }
  }

  const { start, end } = anchor.position;
  if (start >= 0 && end <= text.length && start < end) {
    if (text.slice(start, end) === exact) return "positional";
  }
  return null;
};

/** Does this range anchor re-attach at all? The confidence-blind predicate. */
export const resolveRangeAnchor = (anchor: RangeAnchor, root: DomRootLike): boolean =>
  resolveRangeMatch(anchor, root) !== null;

/**
 * How sure is this anchor's re-attachment, for either kind? `null` when it does
 * not re-attach - a miss is a miss, never a low-confidence guess.
 */
export const anchorMatch = (anchor: Anchor, root: DomRootLike): AnchorMatch | null =>
  anchor.kind === "element"
    ? (resolveElementMatch(anchor, root)?.match ?? null)
    : resolveRangeMatch(anchor, root);

/** Does this anchor re-attach to the given root? */
export const anchorResolves = (anchor: Anchor, root: DomRootLike): boolean =>
  anchorMatch(anchor, root) !== null;
