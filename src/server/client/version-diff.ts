/**
 * What one version of a document added, removed and changed against another.
 *
 * Computed on demand from the two versions. Nothing is stored: lucid keeps
 * whole versions, so a difference is a view over them, and a view that is
 * derived cannot go stale or disagree with the bytes.
 *
 * Three things want this same answer, which is why it is a module rather
 * than part of whatever asks first:
 *
 * 1. Seeing what a revision changed, instead of re-reading the document.
 * 2. The pulse. New material is highlighted when it arrives inside the
 *    reader's viewport, and that needs to know which parts are new.
 * 3. Comparing two versions side by side.
 *
 * ## Why blocks, and why matching is four steps
 *
 * The unit is a **block**: the same leaf elements a person can edit and
 * annotate. Anything smaller reports noise - a word moving between two
 * sentences is not a change anyone asked about - and anything larger reports
 * that "the document changed", which they already knew.
 *
 * The hard case is a block that was **reworded**. Left alone it looks like
 * one block removed and a different one added, in the same place, which is
 * true and useless. Pairing it to its previous self is what makes the answer
 * worth having, and no single rule does it:
 *
 * - **Same text** catches a block that did not change, wherever it moved to.
 * - **Same position** catches a block rewritten so heavily that its words no
 *   longer overlap at all.
 * - **Overlapping words** catches a block that was edited and also moved,
 *   where position says nothing.
 *
 * The thresholds and the order are ported from v1, which ran this against
 * real artifacts. `0.3` word overlap is deliberately generous: a false pair
 * reports a change as a rewrite, and a missed pair reports it as a deletion
 * plus an unrelated addition, which reads far worse.
 */

/** The blocks a difference is reported over.
 *
 * The same set the frame makes editable, deliberately: a difference the
 * person cannot act on is a difference not worth reporting, and two
 * different lists would drift apart. */
const BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,figcaption,pre" as const;

/** Whitespace is layout, not content. An agent that reflows a paragraph to
 * 80 columns has not changed it. */
const normalise = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/** Below this, two blocks are different blocks rather than one edited one.
 *
 * From v1. Low on purpose: pairing wrongly reports an edit, which is close
 * to true; failing to pair reports a deletion and an unrelated insertion,
 * which is not. */
export const PAIR_MIN_OVERLAP = 0.3;

export interface Block {
  readonly el: Element;
  readonly tag: string;
  readonly text: string;
  /** Where it sits among its document's blocks, counted from 0. */
  readonly index: number;
}

/**
 * The blocks of a document, in order.
 *
 * A block that contains another block is skipped: an `li` wrapping a `p`
 * would otherwise report the same words twice, once as itself and once as
 * its child.
 *
 * Exported because a caller that wants to *locate* a change - the pulse, or
 * a side-by-side view - needs the elements these indices refer to.
 */
export const collectBlocks = (doc: Document): readonly Block[] => {
  const out: Block[] = [];
  for (const el of Array.from(doc.querySelectorAll(BLOCK_SELECTOR))) {
    if (el.querySelector(BLOCK_SELECTOR) !== null) continue;
    const text = normalise(el.textContent);
    if (text === "") continue;
    out.push({ el, tag: el.tagName.toLowerCase(), text, index: out.length });
  }
  return out;
};

/** Word-set overlap, 0 to 1. Jaccard: shared words over total distinct
 * words. Order-insensitive on purpose - a sentence with its clauses swapped
 * is an edit of that sentence, not a new one. */
export const overlap = (a: string, b: string): number => {
  const sa = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== ""),
  );
  const sb = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== ""),
  );
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  const union = sa.size + sb.size - shared;
  return union === 0 ? 0 : shared / union;
};

export type ChangeKind = "added" | "removed" | "changed";

export interface Change {
  readonly kind: ChangeKind;
  readonly tag: string;
  /** The text as it was. Absent on `added`. */
  readonly before?: string;
  /** The text as it now is. Absent on `removed`. */
  readonly after?: string;
  /** Index among the later version's blocks. Absent on `removed`, which has
   * no place in the later version. */
  readonly at?: number;
  /** Index among the earlier version's blocks. Absent on `added`. */
  readonly wasAt?: number;
}

/** A control the agent authored, and what it holds.
 *
 * Its own axis rather than part of the block text, because a ticked box
 * changes no words. A block-text difference reports nothing for it, and on
 * a checklist - which is what an artifact often is - that means reporting
 * nothing for the main thing anyone did. */
export interface ControlChange {
  readonly tag: string;
  /** `checkbox`, `text`, and so on. Null for `textarea` and `select`. */
  readonly type: string | null;
  /** The nearest block text, so a person can tell which control this is. */
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly at: number;
}

export interface VersionDiff {
  readonly changes: readonly Change[];
  /** Controls whose value differs. Empty when none do. */
  readonly controls: readonly ControlChange[];
  /** Blocks that survived untouched. Reported because "nine changes" means
   * something different in a document of ten blocks and one of a thousand. */
  readonly unchanged: number;
  /** True when the two versions have the same blocks in the same order. */
  readonly identical: boolean;
}

/** Position among siblings, and the tags above it. Two blocks with the same
 * path sit in the same slot of the same structure, which is the evidence
 * that one replaced the other when the words no longer say so. */
const pathOf = (el: Element): string => {
  const steps: string[] = [];
  // Annotated at every step rather than inferred. Walking up through
  // `parentElement` is self-referential enough that the checker gives up on
  // it and reports the locals as implicitly `any`.
  let node: Element | null = el;
  while (node !== null) {
    const parent: Element | null = node.parentElement;
    if (parent === null) {
      steps.unshift(node.tagName);
      break;
    }
    const kids: readonly Element[] = Array.from(parent.children);
    let nth = 0;
    for (const sib of kids) {
      if (sib.tagName === node.tagName) nth += 1;
      if (sib === node) break;
    }
    steps.unshift(`${node.tagName}[${nth}]`);
    node = parent;
  }
  return steps.join("/");
};

const CONTROL_SELECTOR = "input,textarea,select" as const;

/** What a control holds, as one comparable string.
 *
 * A tick and a typed value are the same question - what does this say now -
 * so they answer in the same shape rather than in two. */
const holds = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return normalise(el.textContent);
  if (tag === "select") {
    const chosen = el.querySelector("option[selected]") ?? el.querySelector("option");
    return normalise(chosen?.textContent ?? "");
  }
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (type === "checkbox" || type === "radio") {
    return el.hasAttribute("checked") ? "on" : "off";
  }
  return normalise(el.getAttribute("value") ?? "");
};

/** Enough to recognise the control by. A person asked what changed does not
 * want to be told "input 4".
 *
 * Tried in order of how deliberately the author named the thing. The block
 * ancestor comes late and stops at the first block: without that stop the
 * walk runs to the body and answers with the top of the document, which
 * names every control in it identically. */
const labelFor = (el: Element): string => {
  const cap = (t: string): string => (t.length > 60 ? `${t.slice(0, 60)}…` : t);

  const aria = normalise(el.getAttribute("aria-label"));
  if (aria !== "") return cap(aria);

  // Walked rather than selected. Building `label[for="..."]` needs the id
  // escaped, and an id is agent-authored text that may carry anything -
  // including a quote, which would end the selector early.
  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    for (const lab of Array.from(el.ownerDocument?.querySelectorAll("label") ?? [])) {
      if (lab.getAttribute("for") !== id) continue;
      const t = normalise(lab.textContent);
      if (t !== "") return cap(t);
      break;
    }
  }

  const wrapping = el.closest("label");
  if (wrapping !== null) {
    const t = normalise(wrapping.textContent);
    if (t !== "") return cap(t);
  }

  let node: Element | null = el.parentElement;
  while (node !== null) {
    if (node.matches(BLOCK_SELECTOR)) {
      const t = normalise(node.textContent);
      if (t !== "") return cap(t);
      break;
    }
    node = node.parentElement;
  }

  // `name` and `id` before `placeholder`. A placeholder is often decorative -
  // the demo artifact's notes field carries a bare ellipsis - while a name is
  // what the author called the thing.
  const name = normalise(el.getAttribute("name") ?? id ?? "");
  if (name !== "") return cap(name);
  return cap(normalise(el.getAttribute("placeholder")));
};

/** Controls, matched between versions by where they sit.
 *
 * By path rather than by order, so inserting a control near the top does not
 * report every control below it as changed. */
const diffControls = (before: Document, after: Document): ControlChange[] => {
  const oldByPath = new Map<string, Element>();
  for (const el of Array.from(before.querySelectorAll(CONTROL_SELECTOR))) {
    const k = pathOf(el);
    if (!oldByPath.has(k)) oldByPath.set(k, el);
  }
  const out: ControlChange[] = [];
  const now = Array.from(after.querySelectorAll(CONTROL_SELECTOR));
  for (let i = 0; i < now.length; i++) {
    const el = now[i] as Element;
    const was = oldByPath.get(pathOf(el));
    // A control with no counterpart arrived with its block, and the block
    // difference already reports that. Reporting it twice is noise.
    if (was === undefined) continue;
    const b = holds(was);
    const a = holds(el);
    if (b === a) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.tagName.toLowerCase() === "input" ? (el.getAttribute("type") ?? "text") : null,
      label: labelFor(el),
      before: b,
      after: a,
      at: i,
    });
  }
  return out;
};

/**
 * What `after` did to `before`.
 *
 * Total: it never throws and never refuses. Two documents that share nothing
 * report every block of one removed and every block of the other added,
 * which is the truthful answer rather than an error.
 */
export const diffVersions = (before: Document, after: Document): VersionDiff => {
  const oldBlocks = collectBlocks(before);
  const newBlocks = collectBlocks(after);

  const unusedOld = new Set(oldBlocks);
  const changes: Change[] = [];
  let unchanged = 0;

  /** Earlier blocks by tag and exact text, first occurrence winning. A
   * document that repeats a line pairs the first of each, which is arbitrary
   * but stable.
   *
   * Keyed on the tag as well as the text, which is where this departs from
   * v1. v1 matched on text alone, so a paragraph promoted to a heading came
   * back as unchanged - the words had not moved, so nothing was reported,
   * and the document had plainly changed. Text is not identity. */
  const same = (b: { tag: string; text: string }): string => `${b.tag}\u0000${b.text}`;
  const oldByText = new Map<string, Block>();
  for (const b of oldBlocks) if (!oldByText.has(same(b))) oldByText.set(same(b), b);

  const oldByPath = new Map<string, Block>();
  for (const b of oldBlocks) {
    const k = pathOf(b.el);
    if (!oldByPath.has(k)) oldByPath.set(k, b);
  }

  // Pass 1: unchanged text. Done first and for every block, so a block that
  // merely moved can never be mistaken for a rewrite of whatever now sits
  // where it used to be.
  const stillOpen: Block[] = [];
  for (const nb of newBlocks) {
    const twin = oldByText.get(same(nb));
    if (twin !== undefined && unusedOld.has(twin)) {
      unusedOld.delete(twin);
      unchanged += 1;
      continue;
    }
    stillOpen.push(nb);
  }

  // Pass 2: same slot in the same structure. Catches a block rewritten so
  // completely that no word survives.
  const afterPath: Block[] = [];
  for (const nb of stillOpen) {
    const sameSlot = oldByPath.get(pathOf(nb.el));
    if (sameSlot !== undefined && unusedOld.has(sameSlot) && sameSlot.tag === nb.tag) {
      unusedOld.delete(sameSlot);
      changes.push({
        kind: "changed",
        tag: nb.tag,
        before: sameSlot.text,
        after: nb.text,
        at: nb.index,
        wasAt: sameSlot.index,
      });
      continue;
    }
    afterPath.push(nb);
  }

  // Pass 3: best surviving word overlap, same tag. Catches a block that was
  // edited and moved, where the slot says nothing.
  for (const nb of afterPath) {
    let best: Block | undefined;
    let bestScore = 0;
    for (const ob of unusedOld) {
      if (ob.tag !== nb.tag) continue;
      const score = overlap(ob.text, nb.text);
      if (score > bestScore) {
        bestScore = score;
        best = ob;
      }
    }
    if (best !== undefined && bestScore >= PAIR_MIN_OVERLAP) {
      unusedOld.delete(best);
      changes.push({
        kind: "changed",
        tag: nb.tag,
        before: best.text,
        after: nb.text,
        at: nb.index,
        wasAt: best.index,
      });
      continue;
    }
    changes.push({ kind: "added", tag: nb.tag, after: nb.text, at: nb.index });
  }

  // Whatever nothing claimed is gone.
  for (const ob of oldBlocks) {
    if (!unusedOld.has(ob)) continue;
    changes.push({ kind: "removed", tag: ob.tag, before: ob.text, wasAt: ob.index });
  }

  // Reported in the later document's order, so reading the list is reading
  // the document. A removed block sits where it used to be.
  const sorted = [...changes].sort((a, b) => (a.at ?? a.wasAt ?? 0) - (b.at ?? b.wasAt ?? 0));

  const controls = diffControls(before, after);

  return {
    changes: sorted,
    controls,
    unchanged,
    identical: sorted.length === 0 && controls.length === 0,
  };
};
