/** Inert saved-source extraction shared by comparison and admission.
 * parse5 builds data, never browser nodes. Scripts, handlers and resource URLs
 * therefore cannot execute or fetch during comparison or source validation. */

import type { DefaultTreeAdapterMap } from "parse5";
import { parse } from "parse5";
import type { AnnotationSpot } from "./annotations.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
export interface Passage {
  readonly author: string;
  readonly depth: number;
  readonly id: string;
  readonly key: string;
  readonly normalized: string;
  readonly selectors: NonNullable<AnnotationSpot["selectors"]>;
  readonly tag: string;
  readonly text: string;
}
export interface ContentSource {
  readonly notices: readonly string[];
  readonly passages: readonly Passage[];
  readonly retained: string;
}
const supported = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "figcaption",
  "pre",
  "dt",
  "dd",
]);
const excluded = new Set([
  "table",
  "img",
  "svg",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "input",
  "select",
  "textarea",
  "button",
  "script",
  "style",
  "template",
  "noscript",
]);
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string): string | undefined =>
  node.attrs.find((a) => a.name === name)?.value;

export const readContentSource = (html: string, author = "agent"): ContentSource => {
  const source = html.replace(/\r\n?/g, "\n");
  const root = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const htmlNode = root.childNodes.find((n) => element(n) && n.tagName === "html");
  const body =
    htmlNode && "childNodes" in htmlNode
      ? htmlNode.childNodes.find((n) => element(n) && n.tagName === "body")
      : undefined;
  const notices = new Set<string>();
  const cuts: { start: number; end: number }[] = [];
  // Remove only instrumentation from the retained source, without serializing
  // unrelated markup. Attribute order and unsupported source changes still count.
  const todo: Node[] = [...root.childNodes];
  while (todo.length) {
    const node = todo.pop();
    if (!node) continue;
    if (element(node)) {
      const location = node.sourceCodeLocation;
      if (attr(node, "data-lucid") !== undefined && location) {
        cuts.push({ start: location.startOffset, end: location.endOffset });
        continue;
      }
      for (const a of node.attrs) {
        if (!a.name.startsWith("data-lucid-") || a.name === "data-lucid-author") continue;
        const range = location?.attrs?.[a.name];
        if (range) {
          let start = range.startOffset;
          while (start > 0 && /\s/.test(source[start - 1] ?? "")) start--;
          cuts.push({ start, end: range.endOffset });
        }
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) todo.push(child);
  }
  let retained = source;
  for (const cut of cuts.sort((a, b) => b.start - a.start))
    retained = retained.slice(0, cut.start) + retained.slice(cut.end);
  if (!body || !element(body))
    return {
      notices: ["E-COMP-04: Saved content could not be extracted."],
      passages: [],
      retained,
    };
  const ids = new Map<Element, string>();
  const paths = new Map<Element, string>();
  const stack: { node: Node; path: string }[] = [{ node: body, path: "body" }];
  let number = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item || !element(item.node)) continue;
    if (number >= 50_000 || item.path.length > 4096)
      return {
        retained,
        passages: [],
        notices: [
          "E-COMP-04: Saved structure exceeds the safe extraction limit. Inspect the saved versions.",
        ],
      };
    if (item.node !== body) ids.set(item.node, `e${++number}`);
    paths.set(item.node, item.path);
    const children = item.node.childNodes.filter(element);
    const counts = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const child of children) totals.set(child.tagName, (totals.get(child.tagName) ?? 0) + 1);
    const next = children.map((child) => {
      const count = (counts.get(child.tagName) ?? 0) + 1;
      counts.set(child.tagName, count);
      return {
        node: child,
        path: `${item.path} > ${child.tagName}${totals.get(child.tagName) === 1 ? "" : `:nth-of-type(${count})`}`,
      };
    });
    for (let i = next.length - 1; i >= 0; i--) {
      const child = next[i];
      if (child) stack.push(child);
    }
  }
  interface Run {
    owner: Element;
    depth: number;
    start: number;
    text: string;
  }
  const runs: Run[] = [];
  let whole = "";
  const pending: { current: Run | null } = { current: null };
  const flush = (): void => {
    if (pending.current?.text.trim()) runs.push(pending.current);
    pending.current = null;
  };
  const walk: { node: Node; owner: Element | null; depth: number; skip: boolean }[] = [
    { node: body, owner: null, depth: 0, skip: false },
  ];
  while (walk.length) {
    const item = walk.pop();
    if (!item) continue;
    const { node } = item;
    if ("value" in node && node.nodeName === "#text") {
      const start = whole.length;
      whole += node.value;
      if (item.skip || !item.owner) {
        flush();
        if (!item.skip && node.value.trim())
          notices.add("Text outside supported passages has not been compared.");
        continue;
      }
      if (
        pending.current?.owner !== item.owner ||
        pending.current.start + pending.current.text.length !== start
      ) {
        flush();
        pending.current = { owner: item.owner, depth: item.depth, start, text: "" };
      }
      pending.current.text += node.value;
    } else if (element(node)) {
      const isExcluded = excluded.has(node.tagName) || attr(node, "data-lucid") !== undefined;
      const skip = item.skip || isExcluded;
      if (isExcluded && attr(node, "data-lucid") === undefined)
        notices.add(`${node.tagName} content has not been compared. Inspect the saved versions.`);
      const owner = !skip && supported.has(node.tagName) ? node : item.owner;
      const depth =
        item.depth +
        (node.tagName === "ul" || node.tagName === "ol" || node.tagName === "blockquote" ? 1 : 0);
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child) walk.push({ node: child, owner, depth, skip });
      }
    }
  }
  flush();
  const passages = runs.map(({ owner, depth, start, text }): Passage => {
    const id = ids.get(owner) ?? "";
    return {
      author: attr(owner, "data-lucid-author") ?? author,
      depth,
      id,
      key: `${id}:${start}`,
      normalized: owner.tagName === "pre" ? text : text.replace(/\s+/g, " ").trim(),
      selectors: {
        css: paths.get(owner) ?? "",
        position: { start, end: start + text.length },
        quote: {
          exact: text,
          prefix: whole.slice(Math.max(0, start - 32), start),
          suffix: whole.slice(start + text.length, start + text.length + 32),
        },
      },
      tag: owner.tagName,
      text,
    };
  });
  if (!passages.length && source.trim())
    notices.add("E-COMP-04: No supported text passages. Inspect the saved versions.");
  return { notices: [...notices], passages, retained };
};

export const ALIGNMENT_CELLS_MAX = 4_000_000;
export interface Alignment {
  readonly pairs: readonly (readonly [number | null, number | null])[];
  readonly coarse: boolean;
}
/** Bound the allocation including the sentinel row and column. */
export const align = (
  n: number,
  m: number,
  equal: (a: number, b: number) => boolean,
  budget = ALIGNMENT_CELLS_MAX,
): Alignment => {
  const pairs: [number | null, number | null][] = [];
  let head = 0;
  while (head < n && head < m && equal(head, head)) {
    pairs.push([head, head]);
    head++;
  }
  let tail = 0;
  while (tail < n - head && tail < m - head && equal(n - tail - 1, m - tail - 1)) tail++;
  const a = n - head - tail,
    b = m - head - tail;
  const coarse = a > 0 && b > 0 && (a + 1) * (b + 1) > budget;
  if (!a || !b || coarse) {
    for (let i = head; i < n - tail; i++) pairs.push([i, null]);
    for (let j = head; j < m - tail; j++) pairs.push([null, j]);
  } else {
    const table = new Uint32Array((a + 1) * (b + 1));
    const at = (i: number, j: number): number => table[i * (b + 1) + j] ?? 0;
    for (let i = a - 1; i >= 0; i--)
      for (let j = b - 1; j >= 0; j--)
        table[i * (b + 1) + j] = equal(head + i, head + j)
          ? 1 + at(i + 1, j + 1)
          : Math.max(at(i + 1, j), at(i, j + 1));
    let i = 0,
      j = 0;
    while (i < a || j < b) {
      if (i < a && j < b && equal(head + i, head + j)) {
        pairs.push([head + i++, head + j++]);
      } else if (i < a && (j === b || at(i + 1, j) >= at(i, j + 1))) pairs.push([head + i++, null]);
      else pairs.push([null, head + j++]);
    }
  }
  for (let i = tail; i > 0; i--) pairs.push([n - i, m - i]);
  return { pairs, coarse };
};
export interface WordPart {
  readonly changed: boolean;
  readonly text: string;
}
export interface ContentRow {
  readonly before: Passage | null;
  readonly after: Passage | null;
  readonly kind: "same" | "changed" | "removed" | "added";
  readonly oldWords: readonly WordPart[];
  readonly newWords: readonly WordPart[];
}
export interface ContentComparison {
  readonly rows: readonly ContentRow[];
  readonly coarse: boolean;
  readonly notice: string;
  readonly sources: readonly [ContentSource, ContentSource];
}
const key = (p: Passage): string => `${p.tag}:${p.normalized}`;
const frequencies = (passages: readonly Passage[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const p of passages) out.set(key(p), (out.get(key(p)) ?? 0) + 1);
  return out;
};
export const compareContent = (
  earlier: string,
  current: string,
  budget = ALIGNMENT_CELLS_MAX,
  authors: readonly [string, string] = ["agent", "agent"],
): ContentComparison => {
  const left = readContentSource(earlier, authors[0]),
    right = readContentSource(current, authors[1]);
  const a = left.passages,
    b = right.passages;
  const sameText =
    a.length === b.length && a.every((p, i) => b[i] && key(p) === key(b[i] as Passage));
  const ca = frequencies(a),
    cb = frequencies(b);
  // Path plus overlap can pair a rewrite for presentation only. Each passage
  // always keeps its own immutable source address, including repeated text.
  const rightPaths = new Map(b.map((p, i) => [p.selectors.css, i]));
  const pathCounts = (passages: readonly Passage[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const p of passages) counts.set(p.selectors.css, (counts.get(p.selectors.css) ?? 0) + 1);
    return counts;
  };
  const pa = pathCounts(a),
    pb = pathCounts(b);
  const keysA = a.map(key),
    keysB = b.map(key);
  const rewrites = new Map<number, number>();
  for (const [i, p] of a.entries()) {
    const j = rightPaths.get(p.selectors.css),
      q = j === undefined ? undefined : b[j];
    if (
      !q ||
      p.tag !== q.tag ||
      ca.get(key(p)) !== 1 ||
      cb.get(key(q)) !== 1 ||
      cb.has(key(p)) ||
      ca.has(key(q))
    )
      continue;
    if (pa.get(p.selectors.css) !== 1 || pb.get(q.selectors.css) !== 1) continue;
    const words = new Set(p.normalized.split(/\s+/)),
      other = new Set(q.normalized.split(/\s+/));
    const common = [...words].filter((w) => other.has(w)).length;
    if (common / (words.size + other.size - common) >= 0.3 && j !== undefined) rewrites.set(i, j);
  }
  const result = align(
    a.length,
    b.length,
    (i, j) => {
      const p = a[i],
        q = b[j];
      return (
        !!p &&
        !!q &&
        ((sameText && i === j) ||
          (keysA[i] === keysB[j] && ca.get(keysA[i] ?? "") === 1 && cb.get(keysB[j] ?? "") === 1) ||
          rewrites.get(i) === j)
      );
    },
    budget,
  );
  let coarse = result.coarse;
  const rows = result.pairs.map(([i, j]): ContentRow => {
    const before = i === null ? null : (a[i] ?? null),
      after = j === null ? null : (b[j] ?? null);
    const kind = !before
      ? "added"
      : !after
        ? "removed"
        : before.normalized === after.normalized
          ? "same"
          : "changed";
    let oldWords: WordPart[] = [],
      newWords: WordPart[] = [];
    if (kind === "changed" && before && after) {
      const old = before.text.match(/\s+|[^\s]+/g) ?? [],
        next = after.text.match(/\s+|[^\s]+/g) ?? [];
      const words = align(old.length, next.length, (x, y) => old[x] === next[y], budget);
      coarse ||= words.coarse;
      for (const [x, y] of words.pairs) {
        if (x !== null) oldWords.push({ changed: y === null, text: old[x] ?? "" });
        if (y !== null) newWords.push({ changed: x === null, text: next[y] ?? "" });
      }
    } else {
      oldWords = before ? [{ changed: kind !== "same", text: before.text }] : [];
      newWords = after ? [{ changed: kind !== "same", text: after.text }] : [];
    }
    return { before, after, kind, oldWords, newWords };
  });
  return {
    rows,
    coarse,
    notice: [left, right].some((source) =>
      source.notices.some((notice) => notice.startsWith("E-COMP-04:")),
    )
      ? "Content comparison is unavailable for one or both saved versions. Inspect the saved versions."
      : left.retained === right.retained
        ? "No saved-content changes."
        : sameText
          ? "No text changes. Other source changes have not been compared."
          : "Text comparison. Other source changes may not be shown.",
    sources: [left, right],
  };
};
