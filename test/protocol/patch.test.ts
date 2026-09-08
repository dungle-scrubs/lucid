/**
 * RFC-08 R2 and R3, as pure functions.
 *
 * Neither touches the store, so this is where most of the oracle lives: a
 * document, some edits, and what comes out.
 */
import { describe, expect, test } from "bun:test";
import { ARTIFACT_BYTES_MAX, TEXT_MAX } from "../../src/protocol/frames.js";
import {
  applyPatch,
  PATCH_EDITS_MAX,
  PATCH_FIND_MAX,
  PATCH_REPLACE_MAX,
  PATCH_REPLACE_TOTAL_MAX,
  parsePatchBody,
} from "../../src/protocol/patch.js";

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

  test("the result of no edits at all is the document unchanged", () => {
    expect(applied(applyPatch(doc, []))).toBe(doc);
  });
});

describe("several edits in one patch", () => {
  const doc = "<ul>\n<li>alpha</li>\n<li>beta</li>\n<li>gamma</li>\n</ul>";

  test("all of them land, in one new document", () => {
    expect(
      applied(
        applyPatch(doc, [
          { find: "<li>alpha</li>", replace: "<li>ALPHA</li>" },
          { find: "<li>gamma</li>", replace: "<li>GAMMA</li>" },
        ]),
      ),
    ).toBe("<ul>\n<li>ALPHA</li>\n<li>beta</li>\n<li>GAMMA</li>\n</ul>");
  });

  test("the order they are listed in cannot change the result", () => {
    // This is the guarantee resolving up front buys. If edits applied in
    // sequence, the second would act on the first one's output and these two
    // orderings could diverge.
    const forward = applyPatch(doc, [
      { find: "alpha", replace: "one" },
      { find: "beta", replace: "two" },
      { find: "gamma", replace: "three" },
    ]);
    const backward = applyPatch(doc, [
      { find: "gamma", replace: "three" },
      { find: "beta", replace: "two" },
      { find: "alpha", replace: "one" },
    ]);
    expect(applied(forward)).toBe(applied(backward));
    expect(applied(forward)).toBe("<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>");
  });

  test("an edit whose replacement changes length does not shift the ones after it", () => {
    // Applying front-to-back without re-basing offsets is the classic way to
    // corrupt this. Every anchor was located in the original, so the apply
    // walks backwards and the offsets stay true.
    expect(
      applied(
        applyPatch("AAA-BBB-CCC", [
          { find: "AAA", replace: "" },
          { find: "BBB", replace: "a much longer replacement" },
          { find: "CCC", replace: "z" },
        ]),
      ),
    ).toBe("-a much longer replacement-z");
  });

  test("an edit may not anchor on text an earlier edit introduces", () => {
    // A real loss, and the price of the guarantee. `NEW` exists nowhere in
    // the original, so it is not found - rather than being found in the
    // output of the edit before it.
    const r = applyPatch(doc, [
      { find: "<li>beta</li>", replace: "<li>NEW</li>" },
      { find: "NEW", replace: "NEWER" },
    ]);
    expect(refusedBy(r)).toContain("E-PATCH-02");
  });

  test("edits that matched overlapping text are refused", () => {
    const r = applyPatch("hello world", [
      { find: "hello world", replace: "goodbye" },
      { find: "world", replace: "planet" },
    ]);
    expect(refusedBy(r)).toContain("E-PATCH-08");
    expect(refusedBy(r)).toContain("0");
    expect(refusedBy(r)).toContain("1");
  });

  test("two edits with the same anchor are an overlap, not a double apply", () => {
    const r = applyPatch(doc, [
      { find: "beta", replace: "x" },
      { find: "beta", replace: "y" },
    ]);
    expect(refusedBy(r)).toContain("E-PATCH-08");
  });

  test("edits that merely touch, without overlapping, are fine", () => {
    // "AB" then "CD" in "ABCD" are adjacent, not overlapping. Refusing these
    // would make an off-by-one in the overlap check invisible.
    expect(
      applied(
        applyPatch("ABCD", [
          { find: "AB", replace: "1" },
          { find: "CD", replace: "2" },
        ]),
      ),
    ).toBe("12");
  });

  test("one bad anchor refuses the whole patch, and none of the others apply", () => {
    const r = applyPatch(doc, [
      { find: "alpha", replace: "one" },
      { find: "not in the document", replace: "x" },
      { find: "gamma", replace: "three" },
    ]);
    expect(refusedBy(r)).toContain("E-PATCH-02");
    expect(refusedBy(r)).toContain("edit 1");
  });

  test("the refusal names an edit by its listed position, not its position in the text", () => {
    // The agent wrote the list; it can only fix the edit it can find.
    const r = applyPatch("xxx AAA yyy BBB", [
      { find: "BBB", replace: "b" },
      { find: "nope", replace: "n" },
    ]);
    expect(refusedBy(r)).toContain("edit 1");
  });
});

describe("the bounds a patch cannot grow past", () => {
  const edit = (find: string, replace: string) => ({ find, replace });

  test("more edits than the bound allows is refused, before any of them is read", () => {
    const many = Array.from({ length: PATCH_EDITS_MAX + 1 }, (_, i) => edit(`f${i}`, `r${i}`));
    const r = refusedBy(parsePatchBody(body(many)));
    expect(r).toContain("E-PATCH-05");
    expect(r).toContain(String(PATCH_EDITS_MAX));
  });

  test("exactly the bound is allowed", () => {
    const many = Array.from({ length: PATCH_EDITS_MAX }, (_, i) => edit(`f${i}`, `r${i}`));
    expect(edits(parsePatchBody(body(many))).length).toBe(PATCH_EDITS_MAX);
  });

  test("an anchor longer than the bound is refused, naming which edit", () => {
    const r = refusedBy(parsePatchBody(body([edit("z".repeat(PATCH_FIND_MAX + 1), "x")])));
    expect(r).toContain("E-PATCH-05");
    expect(r).toContain("edit 0");
    // The reason must not carry the oversize anchor itself.
    expect(r.length).toBeLessThan(500);
  });

  test("a replacement longer than the bound is refused", () => {
    const r = refusedBy(parsePatchBody(body([edit("a", "z".repeat(PATCH_REPLACE_MAX + 1))])));
    expect(r).toContain("E-PATCH-05");
    expect(r.length).toBeLessThan(500);
  });

  test("replacements that individually fit but together do not are refused", () => {
    // The point of the total: each of these is legal on its own, and no
    // per-edit check would catch what they add up to.
    const each = "z".repeat(PATCH_REPLACE_MAX);
    const n = Math.ceil(PATCH_REPLACE_TOTAL_MAX / PATCH_REPLACE_MAX) + 1;
    const r = refusedBy(
      parsePatchBody(body(Array.from({ length: n }, (_, i) => edit(`f${i}`, each)))),
    );
    expect(r).toContain("E-PATCH-05");
    expect(r).toContain("add up to");
  });

  test("the total is refused before applying, not after building the document", () => {
    // Building it first would mean allocating what is about to be thrown away,
    // which is the whole reason this bound exists rather than relying on the
    // check against the result.
    const each = "z".repeat(PATCH_REPLACE_MAX);
    const n = Math.ceil(PATCH_REPLACE_TOTAL_MAX / PATCH_REPLACE_MAX) + 1;
    const parsed = parsePatchBody(body(Array.from({ length: n }, (_, i) => edit(`f${i}`, each))));
    expect("edits" in parsed).toBe(false);
  });

  test("an ordinary patch is nowhere near any of them", () => {
    const parsed = parsePatchBody(
      body([edit("<li>Read the brief</li>", "<li>Read the brief carefully</li>")]),
    );
    expect(edits(parsed).length).toBe(1);
  });
});

describe("what the patch form does and does not unbound", () => {
  test("the artifact bound and the message bound are the same number", () => {
    // RFC-08 R3 says one bound moves in the safe direction: a whole-form
    // document has to fit inside a message, while a patch carries only the
    // edits, so only ARTIFACT_BYTES_MAX applies to the result.
    //
    // True, and much smaller than it sounds. The two constants are equal, so
    // what a patch buys is the fence header and any prose sharing the
    // message - tens of characters, not a category change. Pinned here so
    // nobody plans on the wider reading.
    expect(ARTIFACT_BYTES_MAX).toBe(TEXT_MAX);
  });

  test("the sum bound cannot be reached by a patch the result check would catch anyway", () => {
    // Both are ARTIFACT_BYTES_MAX, so the sum bound is a cheap early refusal
    // for the obvious case rather than a second, tighter limit.
    expect(PATCH_REPLACE_TOTAL_MAX).toBe(ARTIFACT_BYTES_MAX);
  });
});
