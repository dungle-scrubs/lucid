import { describe, expect, test } from "bun:test";
import { diffHtml } from "../src/diff/diff.ts";

const wrap = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

describe("diffHtml", () => {
  test("detects an added block", () => {
    const a = wrap("<ul><li>one</li><li>two</li></ul>");
    const b = wrap("<ul><li>one</li><li>one-and-a-half</li><li>two</li></ul>");
    const r = diffHtml(a, b, 1, 2);
    expect(r.changed).toBe(true);
    const added = r.hunks.filter((h) => h.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0]?.label).toContain("one-and-a-half");
    expect(r.mergedHtml).toContain('data-diff="added"');
  });

  test("detects a removed block as a ghost", () => {
    const a = wrap("<ul><li>one</li><li>two</li><li>three</li></ul>");
    const b = wrap("<ul><li>one</li><li>three</li></ul>");
    const r = diffHtml(a, b, 1, 2);
    const removed = r.hunks.filter((h) => h.kind === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.label).toContain("two");
    expect(r.mergedHtml).toContain("lucid-ghost");
    expect(r.mergedHtml).toContain('data-diff="removed"');
  });

  test("detects a changed block and stacks old over new in place", () => {
    const a = wrap("<p>Backfill from the events table nightly</p>");
    const b = wrap("<p>Backfill from the events table in one batch</p>");
    const r = diffHtml(a, b, 1, 2);
    const changed = r.hunks.filter((h) => h.kind === "changed");
    expect(changed).toHaveLength(1);
    // The old version is struck above, the new version below - one element, two
    // stacked blocks, not two side-by-side columns.
    expect(r.mergedHtml).toContain('<span class="lucid-diff-was">');
    expect(r.mergedHtml).toContain('<span class="lucid-diff-now">');
    expect(r.mergedHtml).toContain("nightly"); // the old text is still shown
    expect(r.mergedHtml).toContain("one batch"); // alongside the new
  });

  test("a rewritten cell pairs by position instead of splitting into columns", () => {
    // A table cell rewritten past word-similarity: it must read as one changed
    // cell (old stacked over new), never an old ghost cell beside the new one.
    const a = wrap("<table><tr><td>Replay Window</td><td>Bounded suffix.</td></tr></table>");
    const b = wrap(
      "<table><tr><td>Replay Window</td><td>How much catch-up a consumer can request from the transport.</td></tr></table>",
    );
    const r = diffHtml(a, b, 1, 2);
    expect(r.hunks.filter((h) => h.kind === "changed")).toHaveLength(1);
    expect(r.hunks.some((h) => h.kind === "removed")).toBe(false);
    expect(r.mergedHtml).toContain('<span class="lucid-diff-was">');
    expect(r.mergedHtml).not.toContain("lucid-ghost");
  });

  test("no changes -> changed false, no hunks", () => {
    const a = wrap("<p>same</p><ul><li>x</li></ul>");
    const r = diffHtml(a, a, 1, 1);
    expect(r.changed).toBe(false);
    expect(r.hunks).toHaveLength(0);
  });

  test("data-lucid-id makes matching exact across reordered text", () => {
    const a = wrap('<li data-lucid-id="s1">Backfill nightly</li>');
    const b = wrap('<li data-lucid-id="s1">Backfill in one batch</li>');
    const r = diffHtml(a, b, 1, 2);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]?.kind).toBe("changed");
    expect(r.hunks[0]?.anchor.kind).toBe("element");
  });

  test("a changed/added hunk's anchor snippet carries original text, not redline markup", () => {
    const a = wrap("<p>Backfill from the events table nightly</p>");
    const b = wrap("<p>Backfill from the events table in one batch</p>");
    const r = diffHtml(a, b, 1, 2);
    const changed = r.hunks.find((h) => h.kind === "changed");
    expect(changed).toBeDefined();
    // The revert anchor snippet must NOT carry Lucid's redline tags; it should
    // reflect the artifact's authored/current text so re-anchoring is faithful.
    expect(changed?.anchor.snippet).not.toContain("<del");
    expect(changed?.anchor.snippet).not.toContain("<ins");
    expect(changed?.anchor.snippet).toContain("Backfill");

    const r2 = diffHtml(wrap("<p>x</p>"), wrap("<p>x</p><p>new item</p>"), 1, 2);
    const added = r2.hunks.find((h) => h.kind === "added");
    expect(added).toBeDefined();
    expect(added?.anchor.snippet).not.toContain("<del");
    expect(added?.anchor.snippet).toContain("new item");
  });
});

describe("diff cost scales with the document, not with its square", () => {
  test("a wide document diffs in linear time (plan 08 M17)", () => {
    // `blockKey` called `computeFingerprint` without a precomputed sibling
    // index, and `indexAmongSiblings` re-walks the sibling list per element -
    // so a WIDE document was quadratic: measured at 39.6ms for 2000 sibling
    // blocks and 630ms for 8000, on a diff that runs per saved version.
    //
    // Plan 04 deferred this as "deep-DOM O(n^2) via textContent". The
    // measurement said otherwise: depth is cheap (6.5ms at depth 2000), and
    // the cost was breadth - which is the shape a real artifact has.
    const build = (n: number, changed: boolean): string =>
      `<body>${Array.from(
        { length: n },
        (_, i) => `<p>paragraph number ${changed && i === 5 ? "FIVE" : i}</p>`,
      ).join("")}</body>`;

    const time = (n: number): number => {
      const t0 = performance.now();
      diffHtml(build(n, false), build(n, true));
      return performance.now() - t0;
    };

    time(1000); // warm
    const small = time(2000);
    const large = time(8000);

    // 4x the blocks. Linear would be ~4x the time; quadratic would be ~16x.
    // The bound is deliberately loose - this guards the COMPLEXITY, not a
    // timing budget, and a loaded machine must not red it.
    expect(large).toBeLessThan(small * 8);
  });
});
