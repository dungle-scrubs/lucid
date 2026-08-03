import { type Anchor, anchorText } from "../../src/anchors/anchor.ts";

/**
 * The browser's half of `anchorText`: a real parser for the markup strip, and
 * the phrasing the chrome reads an anchor in. Pure string work, kept out of the
 * component module so a surface that needs the RULE (the drawer's chip) does
 * not have to import a React component to get it.
 */

/**
 * Markup -> visible text with the browser's own parser, so entities and nested
 * markup come out as exactly what was on screen.
 *
 * `<script>` and `<style>` are REMOVED before the text is read: `textContent`
 * concatenates their bodies like any other text node, so without this the
 * chrome would splice a stylesheet into an excerpt that the DOM-free strip
 * (which drops them) leaves out - the same anchor reading two ways.
 */
export const stripHtmlWithDom = (html: string): string => {
  try {
    const { body } = new DOMParser().parseFromString(html, "text/html");
    for (const el of body.querySelectorAll("script, style")) el.remove();
    return body.textContent ?? "";
  } catch {
    return html;
  }
};

/**
 * A range is a phrase lifted out of a block, so it keeps its quotes; an element
 * is the block itself and reads as itself.
 */
export const targetText = (target: Anchor): string => {
  const text = anchorText(target, { stripHtml: stripHtmlWithDom });
  return target.kind === "range" ? `“${text}”` : text;
};
