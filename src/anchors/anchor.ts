/**
 * Anchor model (RFC §5). An anchor binds an annotation to a target element or
 * text range, following the W3C Web Annotation Data Model selector approach.
 * Resolution is layered so an anchor survives most re-renders:
 *   - element: lucidId -> fingerprint -> domPath
 *   - range:   quote   -> position
 *
 * This module is the canonical schema + server-side validation. The matching
 * capture/resolution logic that runs in the browser lives in `client/`, but
 * both sides share this shape exactly.
 */

export interface ElementAnchor {
  readonly kind: "element";
  /** Present iff the agent supplied a unique `data-lucid-id` (D-047). */
  readonly lucidId?: string;
  /** Content + structure fingerprint, e.g. `li#a3f9·"Backfill from…"`. */
  readonly fingerprint: string;
  /** Structural fallback, e.g. `article>ol>li:nth-child(2)`. */
  readonly domPath: string;
  /** Captured outer HTML of the target, carried back to the agent. */
  readonly snippet: string;
}

export interface RangeQuote {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface RangePosition {
  /** Offsets into the artifact body `textContent` (W3C default; D-047). */
  readonly start: number;
  readonly end: number;
}

export interface RangeAnchor {
  readonly kind: "range";
  readonly quote: RangeQuote;
  readonly position: RangePosition;
  /** Captured selected text, carried back to the agent. */
  readonly snippet: string;
}

export type Anchor = ElementAnchor | RangeAnchor;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isString = (v: unknown): v is string => typeof v === "string";

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validate an untrusted (browser-supplied) anchor. Returns the typed anchor or
 * a reason string. Used server-side so a malformed POST never enters the log.
 */
export const parseAnchor = (input: unknown): Anchor | { readonly error: string } => {
  if (!isRecord(input)) return { error: "anchor must be an object" };

  if (input.kind === "element") {
    if (!isString(input.fingerprint)) return { error: "element anchor missing fingerprint" };
    if (!isString(input.domPath)) return { error: "element anchor missing domPath" };
    if (!isString(input.snippet)) return { error: "element anchor missing snippet" };
    if (input.lucidId !== undefined && !isString(input.lucidId)) {
      return { error: "element anchor lucidId must be a string" };
    }
    const anchor: ElementAnchor = {
      kind: "element",
      fingerprint: input.fingerprint,
      domPath: input.domPath,
      snippet: input.snippet,
      ...(isString(input.lucidId) ? { lucidId: input.lucidId } : {}),
    };
    return anchor;
  }

  if (input.kind === "range") {
    const quote = input.quote;
    const position = input.position;
    if (
      !isRecord(quote) ||
      !isString(quote.exact) ||
      !isString(quote.prefix) ||
      !isString(quote.suffix)
    ) {
      return { error: "range anchor has invalid quote" };
    }
    if (!isRecord(position) || !isFiniteNumber(position.start) || !isFiniteNumber(position.end)) {
      return { error: "range anchor has invalid position" };
    }
    if (!isString(input.snippet)) return { error: "range anchor missing snippet" };
    const anchor: RangeAnchor = {
      kind: "range",
      quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
      position: { start: position.start, end: position.end },
      snippet: input.snippet,
    };
    return anchor;
  }

  return { error: `unknown anchor kind: ${String((input as { kind?: unknown }).kind)}` };
};

/** A short human/agent-readable description of an anchor target. */
export const anchorSnippet = (anchor: Anchor): string => anchor.snippet;
