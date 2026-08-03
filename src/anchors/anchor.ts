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

export interface AnchorTextOptions {
  /** Clip to this many characters. No ellipsis: framing is the caller's. */
  readonly maxChars?: number;
  /** Keep the target's own line breaks instead of folding to one line - for a
   *  surface that quotes the region as a block (the fork seed) rather than
   *  showing it inline. */
  readonly keepLines?: boolean;
  /** Say nothing rather than fall back to markup when the target shows no text
   *  at all - for a caller that has its own name for that case (the drawer's
   *  chip calls it a pinned region). */
  readonly textOnly?: boolean;
  /** Markup -> visible text. Defaults to a DOM-free strip so the same rule runs
   *  server-side; the chrome passes a DOMParser-based one (anchor-text.ts). */
  readonly stripHtml?: (html: string) => string;
}

/**
 * Markup -> visible text without a DOM. `<script>` and `<style>` bodies are
 * dropped whole rather than untagged: their content is not visible text, and a
 * plain tag strip splices a stylesheet into the excerpt. A tag's scan honors
 * quotes, so an attribute value holding a `>` does not end the tag early and
 * leak its tail into the excerpt. Tags become a space, so two block elements
 * written without whitespace between them do not run their words together.
 *
 * What a regex still cannot do is decode entities or follow the parser through
 * malformed markup. That is why `stripHtml` is injectable: the chrome, which
 * has a real parser, passes it.
 */
const stripMarkup = (html: string): string =>
  html
    .replace(/<(script|style)\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g, " ");

/** One line's whitespace, folded to single spaces. */
const foldRuns = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The region kept as a block. Line ends are trimmed and runs of blank lines
 * capped, but the indentation each line carries SURVIVES: an indented code
 * block or an aligned table is shape the human selected, and a surface that
 * quotes the region verbatim must not flatten it.
 *
 * Markup is the exception (`fold`). There a run of spaces is an artifact - a
 * tag became one, or the source's own wrapping did - and not shape anyone
 * chose, so the element path folds each line.
 */
const blockText = (s: string, fold: boolean): string =>
  s
    .split("\n")
    .map((line) => (fold ? foldRuns(line) : line.replace(/\s+$/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");

/**
 * What the human pointed at, as text - the one rule for turning an anchor into
 * words a person or an agent reads.
 *
 * A range is already text: the quote IS the selection. An element's snippet is
 * outerHTML, so what was pointed at is its visible text; handing the markup
 * over raw is soup truncated mid-tag, naming everything except the thing that
 * was clicked. The tag name is not text either - "p" or "div" is a fact about
 * the markup, not about the thing.
 *
 * An element with no visible text at all (an image, a rule) falls back to its
 * markup, because the alternative is an excerpt that says nothing - unless the
 * caller has a better name for nothing than markup soup does (`textOnly`).
 *
 * Framing - quotes, an ellipsis, a placeholder label - stays with the caller;
 * this owns only what the excerpt SAYS.
 */
export const anchorText = (anchor: Anchor, options: AnchorTextOptions = {}): string => {
  const isRange = anchor.kind === "range";
  const raw = isRange ? anchor.quote.exact : anchor.snippet;
  const visible = isRange ? raw : (options.stripHtml ?? stripMarkup)(raw);
  const tidy = (s: string): string =>
    options.keepLines === true ? blockText(s, !isRange) : foldRuns(s);
  const text = tidy(visible) || (options.textOnly === true ? "" : tidy(raw));
  const max = options.maxChars;
  return max !== undefined && text.length > max ? text.slice(0, max) : text;
};
