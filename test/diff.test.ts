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

  test("detects a changed block with inline word redline", () => {
    const a = wrap("<p>Backfill from the events table nightly</p>");
    const b = wrap("<p>Backfill from the events table in one batch</p>");
    const r = diffHtml(a, b, 1, 2);
    const changed = r.hunks.filter((h) => h.kind === "changed");
    expect(changed).toHaveLength(1);
    expect(r.mergedHtml).toContain('<del class="lucid-del">');
    expect(r.mergedHtml).toContain('<ins class="lucid-ins">');
    expect(r.mergedHtml).toContain("one batch");
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
