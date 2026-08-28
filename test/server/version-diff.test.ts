/**
 * What a version added, removed and changed.
 *
 * The case that carries the weight is a **reworded** block. Reported as a
 * removal plus an unrelated addition it is true and useless, so most of what
 * is asserted here is that the three pairing rules find its previous self.
 */
import { describe, expect, test } from "bun:test";
import "../support/dom.js";
import {
  collectBlocks,
  diffVersions,
  overlap,
  PAIR_MIN_OVERLAP,
} from "../../src/server/client/version-diff.js";

const doc = (body: string): Document =>
  new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, "text/html");

const kinds = (d: ReturnType<typeof diffVersions>): string[] => d.changes.map((c) => c.kind);

describe("what counts as a block", () => {
  test("leaf blocks with text, in order", () => {
    const b = collectBlocks(doc("<h1>Title</h1><p>One</p><p>Two</p>"));
    expect(b.map((x) => x.text)).toEqual(["Title", "One", "Two"]);
    expect(b.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  test("a block containing another block is not counted twice", () => {
    // An `li` wrapping a `p` would otherwise report the same words as both.
    const b = collectBlocks(doc("<ul><li><p>Nested</p></li></ul>"));
    expect(b.map((x) => x.tag)).toEqual(["p"]);
  });

  test("empty blocks are not blocks", () => {
    expect(collectBlocks(doc("<p></p><p>   </p><p>Real</p>")).length).toBe(1);
  });

  test("whitespace is layout, so reflowing does not change the text", () => {
    const a = collectBlocks(doc("<p>one two three</p>"))[0];
    const b = collectBlocks(doc("<p>one\n   two\n   three</p>"))[0];
    expect(a?.text).toBe(b?.text as string);
  });
});

describe("word overlap", () => {
  test("identical is 1, disjoint is 0", () => {
    expect(overlap("a b c", "a b c")).toBe(1);
    expect(overlap("a b c", "x y z")).toBe(0);
  });

  test("order does not matter", () => {
    // A sentence with its clauses swapped is an edit of that sentence.
    expect(overlap("the cat sat", "sat the cat")).toBe(1);
  });

  test("a small edit stays well above the pairing bound", () => {
    const before = "Read the front door before any code";
    const after = "Read the front door before writing any code";
    expect(overlap(before, after)).toBeGreaterThan(PAIR_MIN_OVERLAP);
  });
});

describe("nothing changed", () => {
  test("the same document is identical", () => {
    const d = diffVersions(doc("<p>One</p><p>Two</p>"), doc("<p>One</p><p>Two</p>"));
    expect(d.identical).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.unchanged).toBe(2);
  });

  test("a block that only moved is unchanged, not removed and added", () => {
    const d = diffVersions(doc("<p>One</p><p>Two</p>"), doc("<p>Two</p><p>One</p>"));
    expect(d.identical).toBe(true);
    expect(d.unchanged).toBe(2);
  });
});

describe("added and removed", () => {
  test("a new block is added", () => {
    const d = diffVersions(doc("<p>One</p>"), doc("<p>One</p><p>Two</p>"));
    expect(kinds(d)).toEqual(["added"]);
    expect(d.changes[0]?.after).toBe("Two");
    expect(d.changes[0]?.at).toBe(1);
    expect(d.unchanged).toBe(1);
  });

  test("a deleted block is removed, and says where it was", () => {
    const d = diffVersions(doc("<p>One</p><p>Two</p>"), doc("<p>One</p>"));
    expect(kinds(d)).toEqual(["removed"]);
    expect(d.changes[0]?.before).toBe("Two");
    expect(d.changes[0]?.wasAt).toBe(1);
  });

  test("two documents sharing nothing report everything, rather than failing", () => {
    const d = diffVersions(doc("<p>alpha</p>"), doc("<h1>zulu</h1>"));
    expect(kinds(d).sort()).toEqual(["added", "removed"]);
    expect(d.unchanged).toBe(0);
  });
});

describe("a reworded block is changed, not removed and added", () => {
  test("an edit in place", () => {
    const d = diffVersions(
      doc("<p>Read the front door before any code</p>"),
      doc("<p>Read the front door before writing any code</p>"),
    );
    expect(kinds(d)).toEqual(["changed"]);
    expect(d.changes[0]?.before).toBe("Read the front door before any code");
    expect(d.changes[0]?.after).toBe("Read the front door before writing any code");
  });

  test("rewritten so completely no word survives, but in the same slot", () => {
    // Word overlap is zero here. Position is the only evidence, and it is
    // enough: same tag, same place in the same structure.
    const d = diffVersions(
      doc("<div><p>alpha bravo</p></div>"),
      doc("<div><p>xray yankee</p></div>"),
    );
    expect(kinds(d)).toEqual(["changed"]);
  });

  test("edited and moved, where position says nothing", () => {
    const d = diffVersions(
      doc("<p>keep this</p><p>the quick brown fox jumps</p>"),
      doc("<p>the quick brown fox leaps</p><p>keep this</p>"),
    );
    expect(kinds(d)).toEqual(["changed"]);
    expect(d.unchanged).toBe(1);
  });

  test("a different tag is a different block, not an edit of one", () => {
    // Turning a paragraph into a heading is not a rewording of it.
    const d = diffVersions(
      doc("<div><p>alpha bravo</p></div>"),
      doc("<div><h2>alpha bravo</h2></div>"),
    );
    expect(kinds(d).sort()).toEqual(["added", "removed"]);
  });

  test("an unrelated block is not paired with one that left", () => {
    const d = diffVersions(
      doc("<p>alpha bravo charlie</p>"),
      doc("<p>xray yankee zulu</p><p>delta</p>"),
    );
    // The first pairs by slot. The second has nothing left to pair with.
    expect(kinds(d).sort()).toEqual(["added", "changed"]);
  });
});

describe("the order the answer is read in", () => {
  test("changes come in the later document's order", () => {
    const d = diffVersions(
      doc("<p>one</p><p>two</p><p>three</p>"),
      doc("<p>one</p><p>INSERTED</p><p>two</p><p>three</p>"),
    );
    expect(kinds(d)).toEqual(["added"]);
    expect(d.changes[0]?.at).toBe(1);
    expect(d.unchanged).toBe(3);
  });

  test("unchanged is counted so a change count can be read against a size", () => {
    // Nine changes means something different in ten blocks than in a thousand.
    const before = doc(Array.from({ length: 10 }, (_, i) => `<p>line ${i}</p>`).join(""));
    const after = doc(
      `${Array.from({ length: 10 }, (_, i) => `<p>line ${i}</p>`).join("")}<p>extra</p>`,
    );
    const d = diffVersions(before, after);
    expect(d.unchanged).toBe(10);
    expect(d.changes.length).toBe(1);
  });
});

describe("it is a view, so it is repeatable", () => {
  test("the same input gives the same answer", () => {
    const run = (): ReturnType<typeof diffVersions> =>
      diffVersions(
        doc("<p>alpha bravo</p><p>charlie</p>"),
        doc("<p>alpha bravo delta</p><p>echo</p>"),
      );
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  test("nothing is written to the documents it was given", () => {
    // The whole point of computing it on demand: the versions are evidence
    // and stay untouched.
    const before = doc("<p>One</p>");
    const after = doc("<p>Two</p>");
    const html = [before.body.innerHTML, after.body.innerHTML];
    diffVersions(before, after);
    expect([before.body.innerHTML, after.body.innerHTML]).toEqual(html);
  });
});

describe("controls, which change without changing any words", () => {
  test("a ticked checkbox is reported, and says which one", () => {
    // The case a block-text difference cannot see, on the artifact shape
    // lucid is most often used for.
    const d = diffVersions(
      doc("<li><input type=checkbox> Read the front door</li>"),
      doc("<li><input type=checkbox checked> Read the front door</li>"),
    );
    expect(d.changes).toEqual([]);
    expect(d.controls.length).toBe(1);
    expect(d.controls[0]?.before).toBe("off");
    expect(d.controls[0]?.after).toBe("on");
    expect(d.controls[0]?.label).toContain("Read the front door");
    expect(d.identical).toBe(false);
  });

  test("unticking is reported too", () => {
    const d = diffVersions(
      doc("<li><input type=checkbox checked> One</li>"),
      doc("<li><input type=checkbox> One</li>"),
    );
    expect(d.controls[0]?.before).toBe("on");
    expect(d.controls[0]?.after).toBe("off");
  });

  test("a typed field reports what it now says", () => {
    const d = diffVersions(
      doc("<p>Notes</p><textarea>old</textarea>"),
      doc("<p>Notes</p><textarea>new words</textarea>"),
    );
    expect(d.controls[0]?.before).toBe("old");
    expect(d.controls[0]?.after).toBe("new words");
  });

  test("untouched controls are not reported", () => {
    const same = "<li><input type=checkbox checked> One</li><li><input type=checkbox> Two</li>";
    expect(diffVersions(doc(same), doc(same)).controls).toEqual([]);
  });

  test("a control that arrived with its block is not reported twice", () => {
    // The block difference already says the block is new. Saying it again as
    // a control change is noise.
    const d = diffVersions(
      doc("<li><input type=checkbox> One</li>"),
      doc("<li><input type=checkbox> One</li><li><input type=checkbox checked> Two</li>"),
    );
    expect(d.changes.map((c) => c.kind)).toEqual(["added"]);
    expect(d.controls).toEqual([]);
  });

  test("identical is false when only a control moved", () => {
    const d = diffVersions(
      doc("<li><input type=checkbox> One</li>"),
      doc("<li><input type=checkbox checked> One</li>"),
    );
    expect(d.identical).toBe(false);
  });
});

describe("following a block across a version", () => {
  test("an unchanged block says where it went", () => {
    // The reader's place is a block. Keeping it across a new version means
    // following that block, which is what this map is for.
    const d = diffVersions(
      doc("<p>one</p><p>two</p><p>three</p>"),
      doc("<p>NEW</p><p>one</p><p>two</p><p>three</p>"),
    );
    expect(d.carried.get(0)).toBe(1);
    expect(d.carried.get(2)).toBe(3);
  });

  test("a reworded block is still followed", () => {
    const d = diffVersions(
      doc("<p>keep</p><p>the quick brown fox jumps</p>"),
      doc("<p>keep</p><p>the quick brown fox leaps</p>"),
    );
    expect(d.carried.get(1)).toBe(1);
  });

  test("a removed block is absent, rather than pointing somewhere wrong", () => {
    const d = diffVersions(doc("<p>one</p><p>gone</p><p>three</p>"), doc("<p>one</p><p>three</p>"));
    expect(d.carried.has(1)).toBe(false);
    expect(d.carried.get(2)).toBe(1);
  });

  test("every surviving block is accounted for", () => {
    const before = doc("<p>a</p><p>b</p><p>c</p>");
    const after = doc("<p>a</p><p>c</p>");
    const d = diffVersions(before, after);
    expect([...d.carried.entries()].sort()).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });
});
