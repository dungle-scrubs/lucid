import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { align, compareContent, readContentSource } from "../../src/protocol/content-comparison.js";

describe("inert source comparison", () => {
  test("extracts nested prose once and addresses source body order, not filtered rows or author IDs", () => {
    const html =
      '<!doctype html><html><head><title>T</title></head><body><div><h1 id="e88">Title</h1><ul><li>Before <b>bold</b><p>Inner words</p> after<ul><li>Nested</li></ul></li></ul><pre> a\n  b</pre></div></body></html>';
    const source = readContentSource(html);
    expect(source.passages.map((p) => p.text)).toEqual([
      "Title",
      "Before bold",
      "Inner words",
      " after",
      "Nested",
      " a\n  b",
    ]);
    const document = new JSDOM(html).window.document;
    const all = [...document.body.querySelectorAll("*")];
    for (const passage of source.passages) {
      const el = all[Number(passage.id.slice(1)) - 1];
      expect(document.querySelector(passage.selectors.css)).toBe(el ?? null);
      expect(el?.textContent).toContain(passage.text);
      expect(
        document.body.textContent?.slice(
          passage.selectors.position.start,
          passage.selectors.position.end,
        ),
      ).toBe(passage.text);
    }
    expect(source.passages[4]?.depth).toBe(2);
  });
  test("resource nodes and scripts are inert and keep later addresses stable", () => {
    const source = readContentSource(
      '<p>Safe</p><script>throw new Error("executed")</script><img src="https://invalid.test/image"><iframe src="https://invalid.test/frame"></iframe><table><tr><td>Table text</td></tr></table><p>Later</p>',
    );
    expect(source.passages.map((p) => p.text)).toEqual(["Safe", "Later"]);
    expect(source.passages[1]?.id).toBe("e9");
    expect(source.notices.join(" ")).toContain("table content has not been compared");
    expect(source.notices.join(" ")).toContain("script content has not been compared");
  });
  test("retained equality removes only instrumentation and normalizes line endings", () => {
    expect(
      compareContent(
        "<p>one\r\ntwo</p>",
        '<p data-lucid-el="e1">one\ntwo</p><style data-lucid="1">injected</style>',
      ).notice,
    ).toBe("No saved-content changes.");
    expect(
      compareContent('<p class="a">same words</p>', '<p class="b">same words</p>').notice,
    ).toStartWith("No text changes.");
    expect(compareContent("<p>old words here</p>", "<p>new words here</p>").notice).toStartWith(
      "Text comparison.",
    );
  });
  test("prose reflow is ignored but original quotes and preformatted spaces survive", () => {
    expect(compareContent("<p>A  B\nC</p>", "<p>A B C</p>").rows[0]?.kind).toBe("same");
    const diff = compareContent("<pre> A\n B</pre>", "<pre> A\n  B</pre>");
    expect(diff.notice).toStartWith("Text comparison.");
    expect(diff.sources[0].passages[0]?.text).toBe(" A\n B");
    expect(diff.rows[0]?.oldWords.map((w) => w.text).join("")).toBe(" A\n B");
  });
  test("small edits pair words without changing either source address", () => {
    const diff = compareContent(
      "<h1>Title</h1><p>Use the old choice today.</p>",
      "<h1>Title</h1><p>Use the new choice today.</p>",
    );
    expect(diff.rows.map((r) => r.kind)).toEqual(["same", "changed"]);
    expect(diff.rows[1]?.oldWords.filter((w) => w.changed).map((w) => w.text)).toEqual(["old"]);
    expect(diff.rows[1]?.newWords.filter((w) => w.changed).map((w) => w.text)).toEqual(["new"]);
  });
  test("unrelated rewrites and duplicate ambiguity do not gain positional correspondence", () => {
    const diff = compareContent(
      "<p>Entirely old</p><p>Repeated</p><p>Repeated</p>",
      "<p>Unrelated replacement</p><p>Repeated</p>",
    );
    expect(diff.rows.every((r) => r.kind === "added" || r.kind === "removed")).toBe(true);
    const moved = compareContent("<p>Alpha</p><p>Beta</p>", "<p>Beta</p><p>Alpha</p>");
    expect(moved.rows.some((r) => r.kind === "removed")).toBe(true);
    expect(moved.rows.some((r) => r.kind === "added")).toBe(true);
  });
  test("block and word work each have a preallocation bound and preserve both texts", () => {
    const result = align(200_000, 2, () => false, 20);
    expect(result.coarse).toBe(true);
    expect(result.pairs.length).toBe(200_002);
    const diff = compareContent("<p>same a b c d same</p>", "<p>same c b a d same</p>", 4);
    expect(diff.coarse).toBe(true);
    expect(diff.rows[0]?.oldWords.map((w) => w.text).join("")).toBe("same a b c d same");
    expect(diff.rows[0]?.newWords.map((w) => w.text).join("")).toBe("same c b a d same");
  });
  test("unsupported-only content is never silently compared as empty", () => {
    const diff = compareContent('<img src="a">', '<img src="b">');
    expect(diff.sources.every((s) => s.notices.some((n) => n.includes("E-COMP-04")))).toBe(true);
    expect(diff.notice).toContain("Content comparison is unavailable");
  });
});
