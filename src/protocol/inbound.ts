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
import type { AgentProgress } from "../protocol/wire.ts";
import type { AttendantStamp, TurnEndReason } from "../core/events.ts";
import { sanitizeAttendant } from "../core/events.ts";
import { sanitizeBlocked, sanitizeProgress } from "../core/progress.ts";
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

// ---- fork ------------------------------------------------------------------

export interface DecodedFork {
  readonly t: "fork";
  readonly id: string;
  readonly version: number;
  readonly target: Anchor;
  readonly note: string;
  readonly authoredAt?: string;
  readonly images?: readonly PromptImage[];
}

const WELL_FORMED_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Decode a `POST /__lucid/fork` body. The fork id becomes a filesystem path
 *  component, so it is held to a strict safe charset - no path separators or
 *  dots - not merely "non-blank" like a log-only id. */
export const decodeFork = (body: unknown): DecodeResult<DecodedFork> => {
  if (!body || typeof body !== "object") return refuse("invalid fork");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !WELL_FORMED_ID.test(b.id)) return refuse("invalid fork id");
  if (typeof b.note !== "string" || b.note.trim() === "") return refuse("empty fork directive");
  const anchor = parseAnchor(b.target);
  if ("error" in anchor) return refuse(anchor.error);
  const images = decodeImages(b.images);
  const authoredAt = decodeAuthoredAt(b.authoredAt);
  return decoded({
    t: "fork",
    id: b.id,
    version: decodeVersion(b.version),
    target: anchor,
    note: b.note,
    ...(authoredAt ? { authoredAt } : {}),
    ...(images.length > 0 ? { images } : {}),
  });
};

// ---- message ---------------------------------------------------------------

export interface DecodedMessage {
  readonly t: "prompt";
  readonly id: string;
  readonly text: string;
  readonly refs: readonly string[];
  readonly images?: readonly PromptImage[];
}

/** Decode a `POST /__lucid/message` body. A blank message with no images is
 *  refused. `refs` is an optional array of strings; non-strings are dropped. */
export const decodeMessage = (body: unknown): DecodeResult<DecodedMessage> => {
  if (!body || typeof body !== "object") return refuse("invalid message");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.text !== "string") return refuse("invalid message");
  const refs = Array.isArray(b.refs)
    ? b.refs.filter((r): r is string => typeof r === "string")
    : [];
  const images = decodeImages(b.images);
  if (b.text.trim() === "" && images.length === 0) return refuse("empty message");
  return decoded({
    t: "prompt",
    id: b.id,
    text: b.text,
    refs,
    ...(images.length > 0 ? { images } : {}),
  });
};

// ---- revert ----------------------------------------------------------------

export interface DecodedRevert {
  readonly t: "revert";
  readonly id: string;
  readonly target: Anchor;
  readonly targetVersion: number;
  readonly why: string;
}

/** Decode a `POST /__lucid/revert` body. */
export const decodeRevert = (body: unknown): DecodeResult<DecodedRevert> => {
  if (!body || typeof body !== "object") return refuse("invalid revert");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.why !== "string" || typeof b.targetVersion !== "number")
    return refuse("invalid revert");
  const anchor = parseAnchor(b.target);
  if ("error" in anchor) return refuse(anchor.error);
  return decoded({
    t: "revert",
    id: b.id,
    target: anchor,
    targetVersion: Math.trunc(b.targetVersion),
    why: b.why,
  });
};

// ---- reply -----------------------------------------------------------------

export interface DecodedReply {
  readonly t: "agent_reply";
  readonly id: string;
  readonly text: string;
  readonly attendant?: AttendantStamp;
}

/** Decode a `POST /__lucid/reply` body. */
export const decodeReply = (body: unknown): DecodeResult<DecodedReply> => {
  if (!body || typeof body !== "object") return refuse("invalid reply");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.text !== "string") return refuse("invalid reply");
  const attendant = decodeAttendant(b.attendant);
  return decoded({
    t: "agent_reply",
    id: b.id,
    text: b.text,
    ...(attendant ? { attendant } : {}),
  });
};

// ---- ack -------------------------------------------------------------------

export interface DecodedAck {
  readonly t: "agent_ack";
  readonly id: string;
  readonly intent?: "revise" | "reply";
  readonly progress?: AgentProgress;
  readonly blocked?: string;
  readonly covers?: number;
  readonly turnId?: string;
  readonly attendant?: AttendantStamp;
}

/** Decode a `POST /__lucid/ack` body. */
export const decodeAck = (body: unknown): DecodeResult<DecodedAck> => {
  if (!body || typeof body !== "object") return refuse("invalid ack");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string") return refuse("invalid ack");
  const intent = b.intent === "revise" || b.intent === "reply" ? b.intent : undefined;
  const progress = sanitizeProgress(b.progress);
  const blockedRaw = sanitizeBlocked(b.blocked);
  const blocked = blockedRaw;
  const covers =
    typeof b.covers === "number" && Number.isInteger(b.covers) && b.covers >= 0
      ? b.covers
      : undefined;
  const turnId =
    typeof b.turnId === "string" && b.turnId.length > 0 ? b.turnId.slice(0, 128) : undefined;
  const attendant = decodeAttendant(b.attendant);
  return decoded({
    t: "agent_ack",
    id: b.id,
    ...(intent ? { intent } : {}),
    ...(progress ? { progress } : {}),
    ...(blocked ? { blocked } : {}),
    ...(covers !== undefined ? { covers } : {}),
    ...(turnId ? { turnId } : {}),
    ...(attendant ? { attendant } : {}),
  });
};

// ---- turn-ended ------------------------------------------------------------

const TURN_END_REASONS = new Set(["done", "exited", "failed", "usage_limit"]);
const TURN_END_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export interface DecodedTurnEnded {
  readonly t: "agent_turn_ended";
  readonly turnId: string;
  readonly reason: TurnEndReason;
  readonly code?: string;
  readonly attendant?: AttendantStamp;
}

/** Decode a `POST /__lucid/turn-ended` body. Every field is a CLOSED set,
 *  refused rather than coerced. */
export const decodeTurnEnded = (body: unknown): DecodeResult<DecodedTurnEnded> => {
  if (!body || typeof body !== "object") return refuse("invalid turnId");
  const b = body as Record<string, unknown>;
  if (typeof b.turnId !== "string" || b.turnId.length === 0) return refuse("invalid turnId");
  if (typeof b.reason !== "string" || !TURN_END_REASONS.has(b.reason))
    return refuse("invalid reason");
  if (b.code !== undefined && (typeof b.code !== "string" || !TURN_END_CODE.test(b.code)))
    return refuse("invalid code");
  const attendant = decodeAttendant(b.attendant);
  return decoded({
    t: "agent_turn_ended",
    turnId: b.turnId.slice(0, 128),
    reason: b.reason as TurnEndReason,
    ...(typeof b.code === "string" ? { code: b.code } : {}),
    ...(attendant ? { attendant } : {}),
  });
};

// ---- bind ------------------------------------------------------------------

export interface DecodedBind {
  readonly launchId: string;
  readonly attendant: AttendantStamp;
  readonly turnId?: string;
}

/** Decode a `POST /__lucid/bind` body. Validation is refusal, not coercion:
 *  a stamp that cannot vouch (no sessionId, no authority) or a malformed
 *  launchId is a 400, never a cleaned-up record. */
export const decodeBind = (body: unknown): DecodeResult<DecodedBind> => {
  if (!body || typeof body !== "object") return refuse("invalid binding");
  const b = body as Record<string, unknown>;
  const launchId =
    typeof b.launchId === "string" && WELL_FORMED_ID.test(b.launchId) ? b.launchId : undefined;
  if (!launchId) return refuse("invalid launchId");
  const attendant = decodeAttendant(b.attendant);
  if (!attendant?.sessionId || !attendant.sessionIdAuthority)
    return refuse("binding stamp needs sessionId and sessionIdAuthority");
  const turnId =
    typeof b.turnId === "string" && b.turnId.length > 0 ? b.turnId.slice(0, 128) : undefined;
  return decoded({
    launchId,
    attendant,
    ...(turnId ? { turnId } : {}),
  });
};

// ---- rename ----------------------------------------------------------------

export interface DecodedRename {
  readonly title: string;
  readonly replaces?: string;
}

/** Decode a `POST /__lucid/rename` body. One line, bounded: this lands inside
 *  a <title> element and on a tab. The handler does the DOM manipulation; this
 *  validates and normalizes the title field only. */
export const decodeRename = (body: unknown): DecodeResult<DecodedRename> => {
  if (!body || typeof body !== "object") return refuse("invalid title");
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string") return refuse("invalid title");
  const title = b.title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (title === "") return refuse("a title cannot be empty");
  const replaces = typeof b.replaces === "string" ? b.replaces : undefined;
  return decoded({
    title,
    ...(replaces !== undefined ? { replaces } : {}),
  });
};

// ---- no-body routes --------------------------------------------------------

/** The four no-body POST routes each append a fixed event type with no
 *  caller-supplied fields. Rather than special-casing them in the route table,
 *  each goes through its own decoder that returns the fixed event. The body is
 *  ignored - these routes carry no information beyond the route itself. */

export const decodeResolve = (): DecodeResult<{ readonly t: "review_resolved" }> =>
  decoded({ t: "review_resolved" });

export const decodeClear = (): DecodeResult<{ readonly t: "record_cleared" }> =>
  decoded({ t: "record_cleared" });

export const decodeReopen = (): DecodeResult<{ readonly t: "review_reopened" }> =>
  decoded({ t: "review_reopened" });

export const decodeEnd = (): DecodeResult<{ readonly t: "session_ended" }> =>
  decoded({ t: "session_ended" });
