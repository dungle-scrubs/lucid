/**
 * The line comparison behind comparing two versions (RFC-07 R9).
 *
 * It is over the stored bytes, not over a parse, so the thing to assert is
 * that it reports changes a parse would hide: a rewritten attribute, a
 * comment, whitespace inside markup. A comparison that agreed with the
 * rendering would be the block comparison, which already exists and answers
 * a different question.
 */
import { describe, expect, test } from "bun:test";
import { diffLines, LINE_UP_CELLS_MAX } from "../../src/server/client/line-diff.js";

const kinds = (d: ReturnType<typeof diffLines>): string[] => d.rows.map((r) => r.kind);

describe("nothing changed", () => {
  test("the same bytes are identical", () => {
    const d = diffLines("<p>one</p>\n<p>two</p>", "<p>one</p>\n<p>two</p>");
    expect(d.identical).toBe(true);
    expect(kinds(d)).toEqual(["same", "same"]);
    expect(d.added + d.removed + d.changed).toBe(0);
  });

  test("only the line ending differs, which nobody means as a change", () => {
    expect(diffLines("a\r\nb", "a\nb").identical).toBe(true);
  });

  test("two empty documents", () => {
    expect(diffLines("", "").identical).toBe(true);
  });
});

describe("added and removed", () => {
  test("a line added in the middle", () => {
    const d = diffLines("a\nb\nc", "a\nNEW\nb\nc");
    expect(kinds(d)).toEqual(["same", "added", "same", "same"]);
    expect(d.added).toBe(1);
    expect(d.rows[1]?.afterNo).toBe(2);
  });

  test("a line removed from the middle", () => {
    const d = diffLines("a\nGONE\nb", "a\nb");
    expect(kinds(d)).toEqual(["same", "removed", "same"]);
    expect(d.removed).toBe(1);
    expect(d.rows[1]?.beforeNo).toBe(2);
  });

  test("two documents sharing nothing report all of both", () => {
    const d = diffLines("alpha\nbravo", "xray\nyankee");
    expect(d.identical).toBe(false);
    expect(d.rows.every((r) => r.kind !== "same")).toBe(true);
  });

  test("empty against not empty", () => {
    expect(diffLines("", "a\nb").added).toBeGreaterThan(0);
    expect(diffLines("a\nb", "").removed).toBeGreaterThan(0);
  });
});

describe("a rewritten line is one row, not two", () => {
  test("a removal followed by an addition pairs", () => {
    const d = diffLines("a\nold line\nc", "a\nnew line\nc");
    expect(kinds(d)).toEqual(["same", "changed", "same"]);
    expect(d.rows[1]?.before).toBe("old line");
    expect(d.rows[1]?.after).toBe("new line");
    expect(d.changed).toBe(1);
    // Counted once, as a change, rather than also as an add and a remove.
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  test("both line numbers survive the pairing", () => {
    const d = diffLines("a\nold\nc", "a\nnew\nc");
    expect(d.rows[1]?.beforeNo).toBe(2);
    expect(d.rows[1]?.afterNo).toBe(2);
  });
});

describe("what only a byte comparison sees", () => {
  test("an attribute change that alters no text", () => {
    // The block comparison reports nothing here, correctly - the words did
    // not move. Over the bytes it is a change, which is the point.
    const d = diffLines('<p class="a">same words</p>', '<p class="b">same words</p>');
    expect(d.identical).toBe(false);
    expect(kinds(d)).toEqual(["changed"]);
  });

  test("a comment nobody renders", () => {
    const d = diffLines("<p>x</p>\n<!-- note -->", "<p>x</p>");
    expect(d.identical).toBe(false);
    expect(d.removed).toBe(1);
  });

  test("whitespace inside the markup", () => {
    const d = diffLines("<p>\n  x\n</p>", "<p>\n      x\n</p>");
    expect(d.identical).toBe(false);
  });

  test("markup a parse would repair is compared anyway", () => {
    // No tree is built, so nothing needs to be well formed.
    const d = diffLines("<p>one<p>two", "<p>one<p>three");
    expect(d.identical).toBe(false);
  });
});

describe("the bound", () => {
  test("a large document with a small edit stays exact", () => {
    // The ends are trimmed first, so this costs almost nothing.
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const edited = big.replace("line 10000", "line 10000 EDITED");
    const d = diffLines(big, edited);
    expect(d.coarse).toBe(false);
    expect(d.changed).toBe(1);
  });

  test("two large unrelated documents are reported coarsely, and say so", () => {
    // Lining these up would cost more than the answer is worth. It is still
    // true, just not divided line by line - and `coarse` admits it rather
    // than pretending.
    const a = Array.from({ length: 3000 }, (_, i) => `alpha ${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `bravo ${i}`).join("\n");
    const d = diffLines(a, b);
    expect(d.coarse).toBe(true);
    expect(d.identical).toBe(false);
    // Paired position by position, so the two columns line up rather than
    // one running 3000 rows below the other.
    expect(d.rows.length).toBe(3000);
    expect(d.changed).toBe(3000);
  });

  test("the bound is a stated number, not a feeling", () => {
    expect(LINE_UP_CELLS_MAX).toBeGreaterThan(0);
  });
});

describe("it is a view", () => {
  test("the same input gives the same answer", () => {
    const run = (): string => JSON.stringify(diffLines("a\nb\nc", "a\nX\nc"));
    expect(run()).toBe(run());
  });

  test("every row carries a number for each side it exists on", () => {
    const d = diffLines("a\nb", "a\nc\nd");
    for (const r of d.rows) {
      if (r.kind !== "added") expect(typeof r.beforeNo).toBe("number");
      if (r.kind !== "removed") expect(typeof r.afterNo).toBe("number");
    }
  });
});

describe("runs of changed lines", () => {
  test("three lines rewritten are three changed rows, not one plus orphans", () => {
    const d = diffLines("head\na\nb\nc\ntail", "head\nx\ny\nz\ntail");
    expect(kinds(d)).toEqual(["same", "changed", "changed", "changed", "same"]);
    expect(d.changed).toBe(3);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  test("more lines removed than added leaves the remainder as removals", () => {
    const d = diffLines("head\na\nb\nc\ntail", "head\nx\ntail");
    expect(kinds(d)).toEqual(["same", "changed", "removed", "removed", "same"]);
    expect(d.changed).toBe(1);
    expect(d.removed).toBe(2);
  });

  test("more lines added than removed leaves the remainder as additions", () => {
    const d = diffLines("head\na\ntail", "head\nx\ny\nz\ntail");
    expect(kinds(d)).toEqual(["same", "changed", "added", "added", "same"]);
    expect(d.changed).toBe(1);
    expect(d.added).toBe(2);
  });
});
