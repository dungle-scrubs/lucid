/**
 * What an artifact may be called (RFC-07 R11).
 *
 * Its own module, with no imports, because three places need the same
 * answer and they cannot all reach each other: the store writes it, the
 * endpoint refuses a bad one, and the browser field stops you typing one.
 * The bound lives here so those three cannot drift, and so the client is not
 * made to import the store to learn a number.
 *
 * `artifactId` is not this. An id is identity, and it never moves: the agent
 * names it to revise, and every annotation batch carries it. A title is what
 * the page displays, and changing it changes nothing else.
 */

/** How long a title may be, in UTF-16 code units.
 *
 * A policy number, not one derived from anything. Clearly larger than the
 * 128 an `artifactId` gets, because a title is prose and an id is a key, and
 * small enough that no title is a document. The unit is what
 * `String.prototype.length` counts, so one rule holds at the endpoint, in
 * the fold, and in the field with no conversion. */
export const ARTIFACT_TITLE_MAX = 200;

/** The same document name in the reader and the hub. Identity stays unchanged. */
export const artifactDisplayName = (artifact: {
  readonly artifactId: string;
  readonly title?: string;
}): string => artifact.title || artifact.artifactId;

/** A title lucid will store: text, non-empty, bounded, no control
 * characters.
 *
 * Control characters are excluded for the same reason an artifact field
 * excludes them: entries are lines in a file that is read back by line.
 *
 * Whitespace is not trimmed here. What a caller sends is what is stored, and
 * a title that is only whitespace is a title of that shape - the caller
 * decides, not the validator. */
export const isArtifactTitle = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= ARTIFACT_TITLE_MAX &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a stored title must not carry control characters
  !/[\u0000-\u001f\u007f]/.test(v);
