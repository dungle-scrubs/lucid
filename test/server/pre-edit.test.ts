/**
 * Correcting a command in a code block, and what gets saved when you do.
 *
 * A code block was the one piece of a document you could not fix: `pre` was
 * left out of the editable list, so a wrong flag in a checklist could only
 * be described to the agent, never corrected.
 *
 * Making it editable is not the whole answer. In a `pre` a newline IS the
 * content, and every browser writes a new line as markup — `br` in Chrome,
 * a `div` wrapper in Firefox. `contenteditable="plaintext-only"` does not
 * change that: Chrome inserts `br` there too, which is how this was found.
 * Saved as-is, the next version of the document would carry two conventions
 * for one thing.
 */
import { describe, expect, test } from "bun:test";
import "../support/dom.js";
import { instrumentArtifact } from "../../src/server/client/instrument.js";
import { flattenNewlines } from "../../src/server/client/snapshot-dom.js";

const pre = (inner: string): Element => {
  const doc = new DOMParser().parseFromString(`<body><pre>${inner}</pre></body>`, "text/html");
  const el = doc.querySelector("pre");
  if (el === null) throw new Error("no pre");
  return el;
};

/** What the block would be saved as. */
const saved = (inner: string): string => {
  const el = pre(inner);
  flattenNewlines(el);
  return el.innerHTML;
};

describe("line breaks a browser inserted become newlines", () => {
  test("a br is a newline", () => {
    // Chrome, including under plaintext-only.
    expect(saved("bun install<br>bun test")).toBe("bun install\nbun test");
  });

  test("a div wrapper is a newline", () => {
    // Firefox, and older Chrome.
    expect(saved("bun install<div>bun test</div>")).toBe("bun install\nbun test");
  });

  test("a div holding a br is one line, not two elements", () => {
    expect(saved("a<div>b<br>c</div>")).toBe("a\nb\nc");
  });

  test("nested divs each open a line", () => {
    expect(saved("a<div>b</div><div>c</div>")).toBe("a\nb\nc");
  });

  test("newlines already in the block are untouched", () => {
    expect(saved("bun install\nbun run check")).toBe("bun install\nbun run check");
  });

  test("a block nobody edited comes out byte for byte", () => {
    const before = "bun install\nbun run check";
    expect(saved(before)).toBe(before);
  });
});

describe("what it must not touch", () => {
  test("highlighting the agent wrote is left alone", () => {
    // Flattening it would be lucid rewriting a document it was only asked
    // to save.
    const out = saved('<code><span class="k">bun</span> install</code>');
    expect(out).toBe('<code><span class="k">bun</span> install</code>');
  });

  test("a break inside highlighted code still becomes a newline", () => {
    const out = saved('<code><span class="k">bun</span> install<br>bun test</code>');
    expect(out).toBe('<code><span class="k">bun</span> install\nbun test</code>');
  });

  test("an empty block stays empty", () => {
    expect(saved("")).toBe("");
  });
});

describe("the frame runs this exact function", () => {
  test("it is injected by its own source, not written twice", () => {
    // The frame cannot import, so the alternative was a second copy that a
    // test could never reach. If this ever stops matching, the tests above
    // are proving something the frame does not do.
    const out = instrumentArtifact("<!doctype html><html><body><pre>a</pre></body></html>", "d", 1);
    expect(out).toContain("var flattenNewlines =");
    expect(out).toContain('querySelectorAll("div")');
    expect(out).toContain("for (var c = 0; c < pres.length; c++) flattenNewlines(pres[c]);");
  });

  test("the injected source is valid on its own", () => {
    // It is transpiled before it is stringified, so this is the check that
    // what comes out is still JavaScript a browser will run.
    const out = instrumentArtifact("<!doctype html><html><body><pre>a</pre></body></html>", "d", 1);
    const body = out.slice(out.indexOf("<script"), out.indexOf("</script>"));
    expect(() => new Function(body.slice(body.indexOf(">") + 1))).not.toThrow();
  });

  test("it refers to nothing outside itself", () => {
    // The injected copy has no module around it. A reference to an import
    // or a module-scope constant would throw in the frame and nowhere else.
    const src = flattenNewlines.toString();
    for (const name of ["ELEMENT_ATTR", "AUTHOR_ATTR", "FRAME_MESSAGE_SOURCE", "import"]) {
      expect(src).not.toContain(name);
    }
  });
});
