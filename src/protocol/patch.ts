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

import { quoteForRefusal } from "./artifacts.js";

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
  const out: PatchEdit[] = [];
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
  spots.sort((a, b) => b.at - a.at);
  let out = document;
  for (const s of spots) {
    out = out.slice(0, s.at) + s.edit.replace + out.slice(s.at + s.edit.find.length);
  }
  return { document: out };
};
