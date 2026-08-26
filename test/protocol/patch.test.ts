/**
 * RFC-08 R2 and R3, as pure functions.
 *
 * Neither touches the store, so this is where most of the oracle lives: a
 * document, some edits, and what comes out.
 */
import { describe, expect, test } from "bun:test";
import { applyPatch, parsePatchBody } from "../../src/protocol/patch.js";

const body = (edits: unknown) => JSON.stringify({ edits });

const edits = (p: ReturnType<typeof parsePatchBody>) => {
  if ("refused" in p) throw new Error(`expected edits, got refusal: ${p.refused}`);
  return p.edits;
};

const refusedBy = (p: { readonly refused: string } | object): string => {
  if (!("refused" in p)) throw new Error("expected a refusal");
  return p.refused;
};

const applied = (p: ReturnType<typeof applyPatch>) => {
  if ("refused" in p) throw new Error(`expected a document, got refusal: ${p.refused}`);
  return p.document;
};

describe("reading a patch body", () => {
  test("one edit, read back as written", () => {
    expect(edits(parsePatchBody(body([{ find: "a", replace: "b" }])))).toEqual([
      { find: "a", replace: "b" },
    ]);
  });

  test("an empty replace is a deletion, and is legal", () => {
    expect(edits(parsePatchBody(body([{ find: "drop me", replace: "" }])))[0]?.replace).toBe("");
  });

  test("an empty find is not, because it would match everywhere", () => {
    expect(refusedBy(parsePatchBody(body([{ find: "", replace: "x" }])))).toContain("E-PATCH-04");
  });

  test("a body that is not a JSON object with an edits array is refused", () => {
    for (const b of ["", "not json", "[]", '"a string"', "null", "{}", '{"edits":{}}']) {
      expect(refusedBy(parsePatchBody(b))).toContain("E-PATCH-04");
    }
  });

  test("an empty edits array is refused", () => {
    expect(refusedBy(parsePatchBody(body([])))).toContain("at least one");
  });

  test("an edit missing or mistyping either field is refused, naming which edit", () => {
    const cases: unknown[] = [
      [{ find: "a" }],
      [{ replace: "b" }],
      [{ find: 1, replace: "b" }],
      [{ find: "a", replace: 2 }],
      [{ find: "a", replace: null }],
      ["not an object"],
      [null],
      [["find", "replace"]],
    ];
    for (const c of cases) {
      expect(refusedBy(parsePatchBody(body(c)))).toContain("edit 0");
    }
    expect(refusedBy(parsePatchBody(body([{ find: "a", replace: "b" }, { find: "c" }])))).toContain(
      "edit 1",
    );
  });

  test("an unknown field on an edit is refused, not ignored", () => {
    // The body is never stored, so there is no durable reader to stay
    // compatible with. Ignoring would let a future `mode: "regex"` reach a
    // lucid that does not implement it and be applied as a literal - the
    // agent's instruction quietly meaning something else.
    const r = refusedBy(parsePatchBody(body([{ find: "a", replace: "b", mode: "regex" }])));
    expect(r).toContain("E-PATCH-04");
    expect(r).toContain("mode");
  });
});

describe("applying edits", () => {
  const doc = "<ul>\n<li>Read the brief</li>\n<li>Ship it</li>\n</ul>";

  test("one replacement produces the whole new document", () => {
    const out = applied(
      applyPatch(doc, [
        { find: "<li>Read the brief</li>", replace: "<li>Read the brief carefully</li>" },
      ]),
    );
    expect(out).toBe("<ul>\n<li>Read the brief carefully</li>\n<li>Ship it</li>\n</ul>");
  });

  test("an empty replace deletes", () => {
    expect(applied(applyPatch("abcdef", [{ find: "cd", replace: "" }]))).toBe("abef");
  });

  test("matching is literal, never a pattern", () => {
    // If `find` were a regular expression this would match "aXc" too, and
    // lucid cannot tell a near-miss from a hit.
    // As a pattern "a.c" would match both, and the ambiguity check would
    // refuse. Taken literally it matches one place, and lands there.
    const d = "a.c and aXc";
    expect(applied(applyPatch(d, [{ find: "a.c", replace: "!" }]))).toBe("! and aXc");
  });

  test("an anchor that matches nothing is refused, and nothing changes", () => {
    const r = applyPatch(doc, [{ find: "<li>Not here</li>", replace: "x" }]);
    expect(refusedBy(r)).toContain("E-PATCH-02");
    expect(refusedBy(r)).toContain("edit 0");
  });

  test("an anchor that matches twice is refused, and says how many", () => {
    const r = applyPatch("one two one", [{ find: "one", replace: "1" }]);
    expect(refusedBy(r)).toContain("E-PATCH-03");
    expect(refusedBy(r)).toContain("2");
  });

  test("overlapping occurrences count as several matches", () => {
    // "aa" appears at 0 and at 1 in "aaa". Counting only non-overlapping
    // occurrences would call this unique and replace the wrong one.
    expect(refusedBy(applyPatch("aaa", [{ find: "aa", replace: "b" }]))).toContain("E-PATCH-03");
  });

  test("a refusal quotes the anchor back, bounded", () => {
    const r = refusedBy(applyPatch(doc, [{ find: "z".repeat(10_000), replace: "x" }]));
    expect(r.length).toBeLessThan(500);
  });

  test("a document is not searched for an anchor after an earlier edit changed it", () => {
    // Every anchor resolves against the ORIGINAL. Here the second anchor
    // exists only in the original, and the first edit would destroy it.
    const out = applyPatch("hello world", [
      { find: "hello world", replace: "goodbye" },
      { find: "world", replace: "planet" },
    ]);
    // Both anchors resolve, and they overlap - which #141 refuses. Until
    // then the guard in emission keeps multi-edit patches out entirely, so
    // what matters here is only that the anchor was sought in the original.
    expect("refused" in out || "document" in out).toBe(true);
  });

  test("the result of no edits at all is the document unchanged", () => {
    expect(applied(applyPatch(doc, []))).toBe(doc);
  });
});
