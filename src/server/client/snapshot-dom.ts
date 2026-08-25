/**
 * DOM surgery that runs inside the frame, written where it can be tested.
 *
 * The frame's script is injected as a string, so nothing in it can be
 * imported and nothing in it can be reached by a test. What has real logic
 * in it lives here instead and is injected by its own source text.
 *
 * That means one rule for everything in this file: it may use DOM APIs and
 * nothing else. No import, no module-scope constant, no helper from
 * elsewhere. A reference to anything outside the function body is not in the
 * copy that gets injected, and the frame would throw on it.
 */

/**
 * Turn the line breaks a browser inserted into the newlines a `pre` means.
 *
 * In a `pre` a newline IS the content. Every browser writes a new line as
 * markup instead — `br` in Chrome, a `div` wrapper in Firefox — and
 * `contenteditable="plaintext-only"` does not change that; Chrome inserts
 * `br` there too. Saved as-is, a code block someone corrected would carry
 * two conventions for one thing, and the agent reading it back would see
 * markup where the newlines used to be.
 *
 * Anything else inside the block is left exactly as it is: highlighting is
 * the agent's work, and flattening it would be lucid rewriting a document
 * it was only asked to save.
 */
export const flattenNewlines = (pre: Element): void => {
  const doc = pre.ownerDocument;
  // Divs first: a wrapper the browser started a line with may hold `br`s,
  // and unwrapping it after would leave them behind.
  const divs = pre.querySelectorAll("div");
  for (let i = divs.length - 1; i >= 0; i--) {
    const d = divs[i];
    const parent = d?.parentNode;
    if (d === undefined || parent === null || parent === undefined) continue;
    parent.insertBefore(doc.createTextNode("\n"), d);
    while (d.firstChild !== null) parent.insertBefore(d.firstChild, d);
    parent.removeChild(d);
  }
  const brs = pre.querySelectorAll("br");
  for (let j = brs.length - 1; j >= 0; j--) {
    const b = brs[j];
    const parent = b?.parentNode;
    if (b === undefined || parent === null || parent === undefined) continue;
    parent.replaceChild(doc.createTextNode("\n"), b);
  }
};
