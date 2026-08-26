/**
 * The patch form (RFC-08): revising a document by naming what to change.
 *
 * Two pure functions, and deliberately nothing else. Neither reads the store
 * or the record, so the oracle for this whole RFC is a set of documents and
 * the edits applied to them.
 *
 * What arrives is agent-authored input that mutates a stored document. That
 * is the difference from the whole form, where the agent supplies the entire
 * result and lucid stores it verbatim. Here lucid performs an operation
 * described by the agent against bytes the agent did not supply and may not
 * have seen, so every rule below is exact and total: nothing fuzzy, nothing
 * assumed, nothing partially applied.
 *
 * The patch is never stored. Nothing in the record says a version arrived as
 * a patch, and nothing needs to: a reader wants the document, and the
 * document is what is there.
 */

import { ARTIFACT_BYTES_MAX } from "../store/log.js";
import { quoteForRefusal } from "./artifacts.js";

/* RFC-08 R7. Security requires each of these, and an unnamed bound is not a
 * bound. Lengths are counted the way the rest of the store counts them, in
 * string length rather than UTF-8 bytes, so one artifact is not measured two
 * different ways depending on which path it arrived by. */

/** More than this in one block is a rewrite, and the whole form is what a
 * rewrite is for. Open Question 2 in RFC-08: the value is proposed, and is
 * settled by the user or by the first revision that hits it. */
export const PATCH_EDITS_MAX = 50;

/** An anchor wide enough to be unique is far below this. Past it the agent is
 * quoting the document back, and the whole form is cheaper than that. */
export const PATCH_FIND_MAX = 4_096;

/** Larger than any single edit needs, small enough that one edit cannot
 * approach the artifact bound on its own. */
export const PATCH_REPLACE_MAX = 65_536;

/** What all the replacements together may add up to. Refused before applying,
 * so a patch cannot ask lucid to build a document it will then refuse. */
export const PATCH_REPLACE_TOTAL_MAX = ARTIFACT_BYTES_MAX;

/** One replacement: the exact text to find, and what goes there instead. */
export interface PatchEdit {
  /** Matched literally against the bytes of the version being revised. Not a
   * regular expression, not a CSS selector, not a line range. */
  readonly find: string;
  /** May be empty, which deletes the matched text. */
  readonly replace: string;
}

export type PatchParse = { readonly edits: readonly PatchEdit[] } | { readonly refused: string };

export type PatchApply = { readonly document: string } | { readonly refused: string };

/** Only the two fields exist. See `parsePatchBody` for why a third is a
 * refusal rather than something to ignore. */
const EDIT_FIELDS = new Set(["find", "replace"]);

/**
 * Read the body of a `form: "patch"` block.
 *
 * Every refusal here is `E-PATCH-04`, and every one of them means nothing is
 * appended.
 */
export const parsePatchBody = (body: string): PatchParse => {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return {
      refused: `E-PATCH-04 patch-malformed: body is not valid JSON: ${(e as Error).message}`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { refused: "E-PATCH-04 patch-malformed: body must be a JSON object" };
  }
  const edits = (raw as Record<string, unknown>).edits;
  if (!Array.isArray(edits)) {
    return { refused: "E-PATCH-04 patch-malformed: body must have an `edits` array" };
  }
  if (edits.length === 0) {
    return { refused: "E-PATCH-04 patch-malformed: `edits` must have at least one entry" };
  }
  // Counted before anything is read, so an enormous list costs one length
  // check rather than a walk over all of it.
  if (edits.length > PATCH_EDITS_MAX) {
    return {
      refused: `E-PATCH-05 patch-too-many-edits: ${edits.length} edits, the most in one block is ${PATCH_EDITS_MAX}; split the work across blocks or emit the whole document`,
    };
  }
  const out: PatchEdit[] = [];
  let replaceTotal = 0;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { refused: `E-PATCH-04 patch-malformed: edit ${i} must be an object` };
    }
    const rec = e as Record<string, unknown>;
    const { find, replace } = rec;
    if (typeof find !== "string" || find === "") {
      return {
        refused: `E-PATCH-04 patch-malformed: edit ${i} needs a non-empty string \`find\``,
      };
    }
    if (typeof replace !== "string") {
      return { refused: `E-PATCH-04 patch-malformed: edit ${i} needs a string \`replace\`` };
    }
    // Refused, not ignored. Forward compatibility is the habit that argues
    // for ignoring, and it does not apply: the patch body is never stored,
    // so there is no durable reader to stay compatible with. The only reader
    // is the lucid applying it, now. Ignoring an unknown field would let a
    // future agent send {"find":..,"replace":..,"mode":"regex"} to a lucid
    // that does not implement `mode`, and have it applied as a literal - the
    // agent's instruction quietly meaning something else. Refusing says so.
    for (const k of Object.keys(rec)) {
      if (!EDIT_FIELDS.has(k)) {
        return {
          refused: `E-PATCH-04 patch-malformed: edit ${i} has unknown field ${quoteForRefusal(k)}; only \`find\` and \`replace\` exist`,
        };
      }
    }
    if (find.length > PATCH_FIND_MAX) {
      return {
        refused: `E-PATCH-05 patch-too-many-edits: edit ${i} has a ${find.length}-character \`find\`, the most is ${PATCH_FIND_MAX}; an anchor that long is quoting the document, and the whole form is cheaper`,
      };
    }
    if (replace.length > PATCH_REPLACE_MAX) {
      return {
        refused: `E-PATCH-05 patch-too-many-edits: edit ${i} has a ${replace.length}-character \`replace\`, the most is ${PATCH_REPLACE_MAX}`,
      };
    }
    replaceTotal += replace.length;
    if (replaceTotal > PATCH_REPLACE_TOTAL_MAX) {
      return {
        refused: `E-PATCH-05 patch-too-many-edits: the replacements add up to more than ${PATCH_REPLACE_TOTAL_MAX} characters, which is past what an artifact may hold; refused before applying rather than after building it`,
      };
    }
    out.push({ find, replace });
  }
  return { edits: out };
};

/** How many places `needle` appears in `hay`, counting overlaps, stopping
 * once the answer is past what any caller needs to report. */
const countMatches = (hay: string, needle: string, stopAt: number): number => {
  let n = 0;
  for (let from = hay.indexOf(needle); from !== -1; from = hay.indexOf(needle, from + 1)) {
    n += 1;
    if (n >= stopAt) return n;
  }
  return n;
};

/**
 * Apply edits to a document, or refuse and change nothing.
 *
 * **Every anchor is resolved against `document` before any edit is applied.**
 * The first draft of RFC-08 applied edits in order, each against the result
 * of the one before. That is unsafe, and only two of its three outcomes fail
 * loudly: an earlier edit can remove a later anchor (refused), duplicate it
 * (refused), or alter its surroundings so it still matches exactly once **in
 * a place the agent did not mean** - no error, a wrong document, and nothing
 * says so. A refusal costs a turn; a silent wrong-target costs a version
 * nobody reviewed.
 *
 * What an edit matches is therefore decided by the document the agent was
 * looking at, which is the document it wrote the patch against.
 *
 * Exactness is the whole design. A fuzzy match would let a patch land
 * somewhere the agent did not mean, and lucid cannot tell a near-miss from a
 * hit. RFC-06 already made this choice for annotation anchoring, where a spot
 * that cannot be found exactly is reported as lost rather than guessed at.
 */
export const applyPatch = (document: string, edits: readonly PatchEdit[]): PatchApply => {
  // Resolve first, apply second. Nothing below mutates until every anchor
  // has been located in the ORIGINAL document and checked exactly-once.
  const spots: { at: number; edit: PatchEdit }[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as PatchEdit;
    const at = document.indexOf(edit.find);
    if (at === -1) {
      return {
        refused: `E-PATCH-02 patch-anchor-not-found: edit ${i} found no match for ${quoteForRefusal(edit.find)}`,
      };
    }
    const n = countMatches(document, edit.find, 100);
    if (n > 1) {
      return {
        refused: `E-PATCH-03 patch-anchor-ambiguous: edit ${i} matched ${n >= 100 ? "100 or more" : n} places; lengthen the anchor so it matches exactly once`,
      };
    }
    spots.push({ at, edit });
  }

  // Applied by position, so the result does not depend on the order the
  // edits were listed in. Later positions first, so an earlier replacement
  // cannot shift the offsets of the ones still to come.
  const ordered = spots
    .map((s, i) => ({ ...s, listed: i }))
    .sort((a, b) => a.at - b.at || a.listed - b.listed);

  // Two edits that matched overlapping regions are refused. Applying both
  // would make one act on text the other replaced, which is the ordering
  // hazard resolving up front removes - arriving by another route.
  //
  // Two edits with the same `find` land here too: one anchor, one region,
  // claimed twice. There is no reading of that which is not ambiguous.
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as (typeof ordered)[number];
    const cur = ordered[i] as (typeof ordered)[number];
    if (cur.at < prev.at + prev.edit.find.length) {
      const a = Math.min(prev.listed, cur.listed);
      const b = Math.max(prev.listed, cur.listed);
      return {
        refused: `E-PATCH-08 patch-edits-overlap: edits ${a} and ${b} matched overlapping text; one of them is already covered by the other`,
      };
    }
  }

  let out = document;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i] as (typeof ordered)[number];
    out = out.slice(0, s.at) + s.edit.replace + out.slice(s.at + s.edit.find.length);
  }
  return { document: out };
};
