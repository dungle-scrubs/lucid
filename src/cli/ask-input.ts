import { ValidationError } from "../errors.ts";

/**
 * What `lucid ask --group` will accept as TEXT, before any of it means
 * anything.
 *
 * Owns the three refusals a group payload can earn on the way in: nothing at
 * all, more bytes than may be parsed, and text that is not JSON. It is handed
 * the characters rather than the source, so reading stays with the caller (a
 * file, or stdin behind `-`) and every refusal is a function of what arrived.
 *
 * Does NOT own structure. Whether the decoded value is a group of one to five
 * answerable questions belongs to `normalizeQuestionGroup` + `validateGroup`
 * in core/question-contract.ts, which the server runs too - so a group this
 * CLI takes is a group the server would re-accept.
 */

/**
 * The most a question group's JSON may be before it is parsed. The normalizer
 * bounds every FIELD, but only after `JSON.parse` has already materialized
 * whatever a file or a pipe handed in; five questions of twelve choices fit in
 * a fraction of this, so anything past it is not a group.
 */
export const MAX_GROUP_CHARS = 512 * 1024;

/**
 * Decode `--group`'s text into the raw value the contract will normalize.
 * `source` is the origin as the caller wrote it - a path, or `-` for stdin -
 * and appears in every refusal so the agent knows which input it named.
 */
export const decodeGroupText = (raw: string, source: string): unknown => {
  if (raw.trim() === "") {
    throw new ValidationError({
      message:
        source === "-" ? "no question group on stdin" : `cannot read question group: ${source}`,
      detail: { source },
    });
  }
  // Ahead of the parse, deliberately: the ceiling exists to keep a hostile or
  // runaway file out of `JSON.parse`, and a check after it would have already
  // paid the cost it is meant to avoid.
  if (raw.length > MAX_GROUP_CHARS) {
    throw new ValidationError({
      message: `question group is too large (max ${MAX_GROUP_CHARS} characters)`,
      detail: { source },
    });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ValidationError({
      message: `question group is not valid JSON: ${(e as Error).message}`,
      detail: { source },
    });
  }
};
