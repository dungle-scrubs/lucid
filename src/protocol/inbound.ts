/**
 * Inbound request decoding (M5.2): one `decode` per route shape.
 *
 * Each decoder takes the raw JSON body (unknown) and returns either a typed
 * value the handler can append directly, or a `Refusal` explaining why the
 * request was rejected. No decoder throws for bad input - a malformed body is
 * a refusal, not an exception.
 *
 * The shared validators (authoredAt, images, anchor lists) live here so each
 * is enforced in exactly one place. The route handlers shrink to
 * `decode -> serverAppend -> ok`.
 */
import { parseAnchor, type Anchor } from "../anchors/anchor.ts";
import type { AttendantStamp } from "../core/events.ts";
import { sanitizeAttendant } from "../core/events.ts";
import type { PromptImage } from "../core/events.ts";

/** A decoded refusal: the handler returns it as a 400 with the error message. */
export interface Refusal {
  readonly ok: false;
  readonly error: string;
}

/** A successful decode carries the typed event ready to append. */
export interface Decoded<T> {
  readonly ok: true;
  readonly value: T;
}

export type DecodeResult<T> = Decoded<T> | Refusal;

export const refuse = (error: string): Refusal => ({ ok: false, error });
export const decoded = <T>(value: T): Decoded<T> => ({ ok: true, value });

// ---- shared validators -----------------------------------------------------

/** A multi-anchor list is bounded so a runaway client cannot flood the log
 *  with one POST; the chrome caps collection at the same number. */
export const MAX_ANCHORS = 8;

/** Validate an optional multi-anchor list (`targets` on an annotation,
 *  `anchors` on an answer). Every element goes through parseAnchor and ONE
 *  invalid element rejects the whole POST - a half-valid list would store a
 *  note claiming spots it does not have. Returns undefined when the field is
 *  absent or empty, so callers fall back to the single-anchor form. */
export const decodeAnchorList = (input: unknown, field: string): Anchor[] | Refusal | undefined => {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return refuse(`${field} must be an array`);
  if (input.length === 0) return undefined;
  if (input.length > MAX_ANCHORS) return refuse(`too many ${field} (max ${MAX_ANCHORS})`);
  const out: Anchor[] = [];
  for (const item of input) {
    const anchor = parseAnchor(item);
    if ("error" in anchor) return refuse(`${field}[${out.length}]: ${anchor.error}`);
    out.push(anchor);
  }
  return out;
};

/** Validate a browser-supplied pasted-image manifest. */
export const decodeImages = (input: unknown): PromptImage[] => {
  if (!Array.isArray(input)) return [];
  const out: PromptImage[] = [];
  for (const item of input) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as PromptImage).id === "string" &&
      typeof (item as PromptImage).name === "string" &&
      typeof (item as PromptImage).file === "string" &&
      /^[a-f0-9-]+\.[a-z]+$/i.test((item as PromptImage).file)
    ) {
      const it = item as PromptImage;
      out.push({ id: it.id, name: it.name.slice(0, 120), file: it.file });
    }
  }
  return out;
};

/** Client-supplied authorship time, display metadata only (seq stays the
 *  cursor). Bounded sanity check rather than trust: a parseable timestamp
 *  no longer than 40 chars. Returns undefined when absent or unparseable. */
export const decodeAuthoredAt = (input: unknown): string | undefined => {
  if (typeof input === "string" && input.length <= 40 && !Number.isNaN(Date.parse(input))) {
    return input;
  }
  return undefined;
};

/** Validate an untrusted attendant provenance stamp (D18). */
export const decodeAttendant = (input: unknown): AttendantStamp | undefined =>
  sanitizeAttendant(input);

/** Validate the optional version field: a non-negative integer, defaulting
 *  to 0 when absent or malformed. */
export const decodeVersion = (input: unknown): number =>
  typeof input === "number" && Number.isInteger(input) ? input : 0;

// ---- route decoders --------------------------------------------------------

/** The typed annotation event ready to append. */
export interface DecodedAnnotation {
  readonly t: "annotation";
  readonly id: string;
  readonly version: number;
  readonly target: Anchor;
  readonly targets?: readonly Anchor[];
  readonly note: string;
  readonly authoredAt?: string;
  readonly images?: readonly PromptImage[];
}

/** Decode a `POST /__lucid/annotation` body. Cmd-collected picks arrive as
 *  `targets`; `target` is DERIVED as the first, never taken from the caller
 *  beside them (two sources for one spot is how they drift). A singleton list
 *  normalizes to the canonical single form so the log has one shape per arity. */
export const decodeAnnotation = (body: unknown): DecodeResult<DecodedAnnotation> => {
  if (!body || typeof body !== "object") return refuse("invalid annotation");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.note !== "string") return refuse("invalid annotation");

  const targetList = decodeAnchorList(b.targets, "targets");
  if (targetList && "ok" in targetList) return targetList;

  const anchor = targetList ? targetList[0]! : parseAnchor(b.target);
  if ("error" in anchor) return refuse(anchor.error);

  const targets = targetList && targetList.length > 1 ? targetList : undefined;
  const images = decodeImages(b.images);
  const authoredAt = decodeAuthoredAt(b.authoredAt);

  return decoded({
    t: "annotation",
    id: b.id,
    version: decodeVersion(b.version),
    target: anchor,
    ...(targets ? { targets } : {}),
    note: b.note,
    ...(authoredAt ? { authoredAt } : {}),
    ...(images.length > 0 ? { images } : {}),
  });
};
