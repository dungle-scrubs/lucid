/**
 * Finding a spot again after the agent has rewritten the document.
 *
 * The case these are all about: a note written against version three, and
 * versions four and five written since by an agent that did not know the
 * note existed.
 */
import { describe, expect, test } from "bun:test";
import "../support/dom.js";
import {
  elementFor,
  resolveSpot,
  type SpotSelectors,
  selectorsFor,
  selectorsForQuote,
  sha256Hex,
} from "../../src/server/client/anchor.js";

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

const V1 = `<body>
<h1>Release checklist</h1>
<p>Run bun run check and confirm lint, typecheck, and tests are green.</p>
<p>Tag the release commit and push the tag.</p>
<p>Publish the package and verify it resolves from the registry.</p>
</body>`;

/** The selectors a note against `elementId` in V1 would carry. */
const spotIn = (html: string, elementId: string): SpotSelectors => {
  const sel = selectorsFor(parse(html), elementId);
  if (sel === null) throw new Error(`no element ${elementId}`);
  return sel;
};

describe("what is written when the note is made", () => {
  test("three ways of finding the spot, all pointing at it", () => {
    const sel = spotIn(V1, "e2");
    expect(sel.quote.exact).toContain("Run bun run check");
    // Context on both sides, so two identical paragraphs can be told apart.
    expect(sel.quote.prefix).toContain("Release checklist");
    expect(sel.quote.suffix).toContain("Tag the release");
    expect(sel.position.end).toBeGreaterThan(sel.position.start);
    expect(sel.css).toContain("body >");
  });

  test("the path is built from structure, not the document's own ids", () => {
    const sel = spotIn('<body><p id="theirs" class="a">one</p><p>two</p></body>', "e1");
    // An agent may reuse, drop, or rename an id or class between versions,
    // and a path built from them looks stable while pointing elsewhere.
    expect(sel.css).not.toContain("theirs");
    expect(sel.css).not.toContain(".a");
  });

  test("an element that does not exist has no selectors", () => {
    expect(selectorsFor(parse(V1), "e99")).toBeNull();
  });
});

describe("finding it again", () => {
  test("unchanged, it is found exactly", () => {
    const r = resolveSpot(parse(V1), spotIn(V1, "e2"), true);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.how).toBe("exact");
    expect(elementFor(parse(V1), r.elementId)?.textContent).toContain("Run bun run check");
  });

  test("reworded, it is still found — which an exact match alone would miss", () => {
    const reworded = `<body>
<h1>Release checklist</h1>
<p>Run bun run check and confirm that lint, typecheck, and every test is green.</p>
<p>Tag the release commit and push the tag.</p>
<p>Publish the package and verify it resolves from the registry.</p>
</body>`;
    const r = resolveSpot(parse(reworded), spotIn(V1, "e2"), true);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(elementFor(parse(reworded), r.elementId)?.textContent).toContain("Run bun run check");
  });

  test("moved down the document, it is still found", () => {
    const moved = `<body>
<h1>Release checklist</h1>
<p>A step the agent added at the top.</p>
<p>Another new step.</p>
<p>Run bun run check and confirm lint, typecheck, and tests are green.</p>
<p>Tag the release commit and push the tag.</p>
</body>`;
    const r = resolveSpot(parse(moved), spotIn(V1, "e2"), true);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(elementFor(parse(moved), r.elementId)?.textContent).toContain("Run bun run check");
  });

  test("how confidently it re-attached is reported, not just whether", () => {
    const r = resolveSpot(parse(V1), spotIn(V1, "e2"), true);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    // A caller can tell a confident match from a hopeful one.
    expect(["exact", "approximate", "position", "css"]).toContain(r.how);
  });

  test("a match by position is qualified as such", () => {
    // The same text in two places, so the quote layer refuses rather than
    // picking one. The offset is what separates them, and the layer that
    // used it says so rather than passing as a confident match.
    const twice = "<body><p>Do the thing.</p><p>Do the thing.</p></body>";
    const doc = parse(twice);
    const second = selectorsFor(doc, "e2");
    if (second === null) throw new Error("no e2");
    const r = resolveSpot(parse(twice), { ...second, css: "body > gone" }, true);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.how).toBe("position");
  });
});

describe("a layer that matches twice is discarded, not guessed at", () => {
  test("the same text in two places does not pick one", () => {
    const twice = `<body>
<p>lead in</p>
<p>Do the thing.</p>
<p>middle</p>
<p>Do the thing.</p>
</body>`;
    const sel: SpotSelectors = {
      quote: { exact: "Do the thing.", prefix: "", suffix: "" },
      // Nowhere to fall to: position is past the end and the path is absent.
      position: { start: 100_000, end: 100_010 },
      css: "body > nothing",
    };
    const r = resolveSpot(parse(twice), sel, true);
    // Falling through is better than pointing the note at the wrong
    // paragraph confidently.
    expect(r.resolved).toBe(false);
  });

  test("a path matching twice is refused rather than taking the first", () => {
    const sel: SpotSelectors = {
      quote: { exact: "nowhere at all in this document", prefix: "", suffix: "" },
      position: { start: 100_000, end: 100_010 },
      css: "p",
    };
    const r = resolveSpot(parse(V1), sel, true);
    expect(r.resolved).toBe(false);
    if (r.resolved) return;
    expect(r.why).toBe("ambiguous");
  });
});

describe("the snapshot guard", () => {
  test("an unverified source version re-anchors nothing", () => {
    const r = resolveSpot(parse(V1), spotIn(V1, "e2"), false);
    expect(r.resolved).toBe(false);
    if (r.resolved) return;
    // Never re-pointed at whatever now occupies that space.
    expect(r.why).toBe("unverified-source");
  });

  test("the hash is the one the store writes", async () => {
    // The store digests SHA-256 over the bytes and stores it hex; the page
    // has to compute the same thing or the guard would refuse everything.
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("a spot that is gone", () => {
  test("a deleted paragraph resolves nowhere", () => {
    const deleted = `<body>
<h1>Release checklist</h1>
<p>Tag the release commit and push the tag.</p>
</body>`;
    const sel = spotIn(V1, "e2");
    // The path would still match something, so it is removed to test the
    // case where nothing at all survives.
    const r = resolveSpot(parse(deleted), { ...sel, css: "body > gone" }, true);
    expect(r.resolved).toBe(false);
    if (r.resolved) return;
    expect(r.why).toBe("not-found");
  });

  test("it is never re-pointed at what took its place", () => {
    const replaced = `<body>
<h1>Release checklist</h1>
<p>Something else entirely, written later by the agent.</p>
<p>Tag the release commit and push the tag.</p>
</body>`;
    const sel = spotIn(V1, "e2");
    const r = resolveSpot(parse(replaced), { ...sel, css: "body > gone" }, true);
    // The quote does not match this text, so the note does not silently
    // become a note about a paragraph its author never saw.
    if (r.resolved) {
      expect(elementFor(parse(replaced), r.elementId)?.textContent).not.toContain(
        "Something else entirely",
      );
    }
  });
});

describe("a note over several spots", () => {
  test("each resolves on its own, and whichever survive are kept", () => {
    const later = `<body>
<h1>Release checklist</h1>
<p>Run bun run check and confirm lint, typecheck, and tests are green.</p>
<p>Publish the package and verify it resolves from the registry.</p>
</body>`;
    const kept = resolveSpot(parse(later), spotIn(V1, "e2"), true);
    const gone = resolveSpot(parse(later), { ...spotIn(V1, "e3"), css: "body > gone" }, true);
    expect(kept.resolved).toBe(true);
    expect(gone.resolved).toBe(false);
  });
});

describe("a path locates, the quote confirms", () => {
  const V = "<body><h1>Head</h1><p>The paragraph I annotated.</p><p>Second.</p></body>";

  test("the same path holding different text does not take the note", () => {
    // `p:nth-of-type(1)` matches whatever the first paragraph now is. A
    // path names a position in the structure, not a thing.
    const replaced =
      "<body><h1>Head</h1><p>Something else the agent wrote.</p><p>Second.</p></body>";
    const sel = selectorsFor(parse(V), "e2");
    if (sel === null) throw new Error("no e2");
    const r = resolveSpot(parse(replaced), sel, true);
    expect(r.resolved).toBe(false);
    if (r.resolved) return;
    expect(r.why).toBe("not-found");
  });

  test("the same path still holding the text keeps the note", () => {
    // Restructured around it, so the quote search over the whole body has
    // more to sift; the path narrows it and the quote confirms.
    const around =
      "<body><h1>Head</h1><p>The paragraph I annotated.</p><p>Second.</p><p>Third.</p></body>";
    const sel = selectorsFor(parse(V), "e2");
    if (sel === null) throw new Error("no e2");
    const r = resolveSpot(parse(around), sel, true);
    expect(r.resolved).toBe(true);
  });
});

describe("the prefix does not drag the search somewhere wrong", () => {
  test("a spot whose surroundings changed is still found by its own text", () => {
    const before = `<body><h1>Checklist</h1>
<p>Run the gate and confirm it is green.</p>
<p>Tag the commit.</p></body>`;
    // The heading survives, so the prefix matches — at the top, where the
    // annotated text no longer is. Retrying without that hint is what finds
    // it.
    const after = `<body><h1>Checklist</h1>
<p>Make sure the tree is clean.</p>
<p>Run the gate and confirm it is green.</p>
<p>Tag the commit.</p></body>`;
    const sel = selectorsFor(parse(before), "e2");
    if (sel === null) throw new Error("no e2");
    const r = resolveSpot(parse(after), sel, true);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(elementFor(parse(after), r.elementId)?.textContent).toContain("Run the gate");
  });
});

describe("anchoring to selected text rather than a whole element", () => {
  /** Ids are assigned the way the frame assigns them: document order over
   * everything inside body. */
  const ID = "e2";
  const HTML = "<body><div><p>Read the brief before you start.</p><p>Ship it.</p></div></body>";

  test("the quote is the selected words, not the whole element", () => {
    const sel = selectorsForQuote(parse(HTML), ID, "the brief");
    expect(sel?.quote.exact).toBe("the brief");
  });

  test("its offsets cover only those words", () => {
    const d = parse(HTML);
    const sel = selectorsForQuote(d, ID, "the brief");
    const whole = d.body?.textContent ?? "";
    expect(sel).not.toBeNull();
    if (sel === null) return;
    expect(whole.slice(sel.position.start, sel.position.end)).toBe("the brief");
  });

  test("context comes from either side of the words", () => {
    const sel = selectorsForQuote(parse(HTML), ID, "the brief");
    expect(sel?.quote.prefix).toContain("Read ");
    expect(sel?.quote.suffix).toContain(" before");
  });

  test("the occurrence inside the named element wins", () => {
    // "Ship it" appears twice. Anchoring to the first occurrence anywhere
    // would point a note at a paragraph nobody selected.
    const two = "<body><p>Ship it.</p><p>Then Ship it again.</p></body>";
    const d = parse(two);
    const second = selectorsForQuote(d, "e2", "Ship it");
    const whole = d.body?.textContent ?? "";
    expect(second).not.toBeNull();
    if (second === null) return;
    // Past the first paragraph, which is 8 characters long.
    expect(second.position.start).toBeGreaterThan(8);
    expect(whole.slice(second.position.start, second.position.end)).toBe("Ship it");
  });

  test("text that is not in the named element falls back to the element", () => {
    // Covering more than the person meant beats anchoring into text they
    // never selected.
    const sel = selectorsForQuote(parse(HTML), ID, "Ship it");
    expect(sel?.quote.exact).toBe("Read the brief before you start.");
  });

  test("an unknown element or empty selection anchors nothing", () => {
    expect(selectorsForQuote(parse(HTML), "e99", "the brief")).toBeNull();
    expect(selectorsForQuote(parse(HTML), ID, "")).toBeNull();
  });

  test("a selected-text anchor resolves back to its element", () => {
    // The whole point: after the agent rewrites around it, the note still
    // finds the spot. `resolveSpot` searches by quote first.
    const d = parse(HTML);
    const sel = selectorsForQuote(d, ID, "the brief");
    expect(sel).not.toBeNull();
    if (sel === null) return;
    const moved = parse(
      "<body><div><h2>New heading</h2><p>Read the brief before you start.</p></div></body>",
    );
    // `verified` is the snapshot guard's answer; nothing re-anchors without it.
    const got = resolveSpot(moved, sel, true);
    expect(got.resolved).toBe(true);
  });

  test("a whole-element anchor is unchanged by the shared context helper", () => {
    const sel = selectorsFor(parse(HTML), ID);
    expect(sel?.quote.exact).toBe("Read the brief before you start.");
    expect(sel?.quote.suffix).toContain("Ship it");
  });
});
