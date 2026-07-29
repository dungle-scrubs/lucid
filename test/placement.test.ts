import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactLocation, sessionPaths } from "../src/core/paths.ts";

/**
 * Artifacts live at `<project>/.lucid/<name>.html` (plan 05, M3.2, D-011).
 *
 * The placement was documented and unenforced, so an agent following the
 * pre-02 convention wrote `<project>/lucid/<name>.html` - and the
 * record-beside-artifact rule then correctly derived `<project>/lucid/.lucid/`.
 * Internally consistent, wrong place, and found in the wild. The product must
 * not depend on every agent having read the current skill.
 *
 * This is placement only. `sessionPaths`, whose record-beside-artifact rule is
 * correct, is unchanged - the two are deliberately separate decisions.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A project: a real temp dir with a `.git` in it. */
const project = async (): Promise<string> => {
  const d = await realpath(await mkdtemp(join(tmpdir(), "lucid-placement-")));
  dirs.push(d);
  await mkdir(join(d, ".git"), { recursive: true });
  return d;
};

describe("canonicalArtifactLocation", () => {
  test("`<root>/.lucid/plan.html` is canonical", async () => {
    const root = await project();
    expect(canonicalArtifactLocation(join(root, ".lucid", "plan.html"))).toEqual({ ok: true });
  });

  test("`<root>/lucid/plan.html` - the pre-02 convention - reports the canonical path", async () => {
    const root = await project();
    expect(canonicalArtifactLocation(join(root, "lucid", "plan.html"))).toEqual({
      ok: false,
      canonical: join(root, ".lucid", "plan.html"),
    });
  });

  test("`<root>/plan.html` at the project root reports the canonical path", async () => {
    const root = await project();
    expect(canonicalArtifactLocation(join(root, "plan.html"))).toEqual({
      ok: false,
      canonical: join(root, ".lucid", "plan.html"),
    });
  });

  test("`<root>/docs/plan.html` reports the canonical path - depth is not a defence", async () => {
    const root = await project();
    expect(canonicalArtifactLocation(join(root, "docs", "plan.html"))).toEqual({
      ok: false,
      canonical: join(root, ".lucid", "plan.html"),
    });
  });

  test("a nested folder INSIDE .lucid is still not canonical", async () => {
    const root = await project();
    expect(canonicalArtifactLocation(join(root, ".lucid", "drafts", "plan.html"))).toEqual({
      ok: false,
      canonical: join(root, ".lucid", "plan.html"),
    });
  });

  /**
   * The escape hatch is the absence of a project, not a flag (D-015). An agent
   * scratchpad has no root to be canonical against, and D-022's ephemeral
   * records already live there.
   */
  test("a path outside any project is ok - there is no root to be canonical against", async () => {
    const d = await realpath(await mkdtemp(join(tmpdir(), "lucid-noproject-")));
    dirs.push(d);
    expect(canonicalArtifactLocation(join(d, "plan.html"))).toEqual({ ok: true });
  });

  test("the nearest enclosing project wins, not the outermost", async () => {
    const outer = await project();
    const inner = join(outer, "packages", "app");
    await mkdir(join(inner, ".git"), { recursive: true });
    expect(canonicalArtifactLocation(join(inner, "docs", "plan.html"))).toEqual({
      ok: false,
      canonical: join(inner, ".lucid", "plan.html"),
    });
  });

  test("a symlinked spelling is judged on the REAL path, like every identity surface", async () => {
    const root = await project();
    await mkdir(join(root, ".lucid"), { recursive: true });
    const real = join(root, ".lucid", "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    const { symlink } = await import("node:fs/promises");
    await symlink(real, join(root, "link.html"));
    // The link SPELLING sits at the project root, which is not canonical - but
    // the file it names is exactly where it should be.
    expect(canonicalArtifactLocation(join(root, "link.html"))).toEqual({ ok: true });
  });
});

describe("open refuses a non-canonical artifact (plan 05, M3.2)", () => {
  test("the refusal names the canonical path, and creates NO record", async () => {
    const { assertCanonicalLocation } = await import("../src/core/session.ts");
    const root = await project();
    const stray = join(root, "docs", "plan.html");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(stray, "<!doctype html><html><body><h1>plan</h1></body></html>");

    expect(() => assertCanonicalLocation(stray)).toThrow(
      new RegExp(join(root, ".lucid", "plan.html").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    // The failure mode this closes: a record quietly appearing beside the
    // misplaced artifact, which then has to be migrated by hand.
    expect(existsSync(sessionPaths(stray).sessionDir)).toBe(false);
  });

  test("a canonical artifact is not refused", async () => {
    const { assertCanonicalLocation } = await import("../src/core/session.ts");
    const root = await project();
    await mkdir(join(root, ".lucid"), { recursive: true });
    const good = join(root, ".lucid", "plan.html");
    await writeFile(good, "<!doctype html><html><body><h1>plan</h1></body></html>");
    expect(() => assertCanonicalLocation(good)).not.toThrow();
  });

  test("an artifact outside any project is not refused", async () => {
    const { assertCanonicalLocation } = await import("../src/core/session.ts");
    const d = await realpath(await mkdtemp(join(tmpdir(), "lucid-noproject-")));
    dirs.push(d);
    const scratch = join(d, "plan.html");
    await writeFile(scratch, "<!doctype html><html><body><h1>plan</h1></body></html>");
    expect(() => assertCanonicalLocation(scratch)).not.toThrow();
  });
});
