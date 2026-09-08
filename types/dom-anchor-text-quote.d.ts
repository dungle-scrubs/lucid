/**
 * Types for `dom-anchor-text-quote`, which ships none.
 *
 * Only what lucid uses is declared. Written narrowly on purpose: a wider
 * declaration would claim more about the library than has been checked.
 */
declare module "dom-anchor-text-quote" {
  export interface TextQuoteSelector {
    readonly exact: string;
    readonly prefix?: string;
    readonly suffix?: string;
  }
  /** The approximate search. Null when nothing close enough was found. */
  export function toRange(
    root: Node,
    selector: TextQuoteSelector,
    options?: Record<string, unknown>,
  ): Range | null;
  export function fromRange(root: Node, range: Range): TextQuoteSelector;
  export function toTextPosition(
    root: Node,
    selector: TextQuoteSelector,
    options?: Record<string, unknown>,
  ): { start: number; end: number } | null;
  export function fromTextPosition(
    root: Node,
    position: { start: number; end: number },
  ): TextQuoteSelector;
}
