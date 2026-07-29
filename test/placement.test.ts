import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

describe("a canonical path that is the SAME FILE is accepted (plan 05, F7)", () => {
  /**
   * APFS is case-insensitive by default, so `<root>/.Lucid/p.html` and
   * `<root>/.lucid/p.html` are ONE file. A `===` on the strings called that
   * non-canonical and told the human to move the file to where it already was:
   * the `mv` is a no-op and the refusal never clears. Sameness is decided by
   * the filesystem, not by string equality.
   */
  test("a case-variant of .lucid on a case-insensitive filesystem is not refused", async () => {
    const root = await project();
    await mkdir(join(root, ".lucid"), { recursive: true });
    const real = join(root, ".lucid", "p.html");
    await writeFile(real, "<h1>p</h1>");
    const variant = join(root, ".Lucid", "p.html");
    if (!existsSync(variant)) return; // case-SENSITIVE fs: the variant is a different file, and refusing it is right
    expect(canonicalArtifactLocation(variant)).toEqual({ ok: true });
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

describe("the refusal accounts for an existing record (plan 05, F2)", () => {
  /**
   * The refusal said "move it to <root>/.lucid/plan.html" and stopped there.
   * A human with an existing session followed that exactly and lost
   * everything: the record stayed at <root>/plan/, the moved artifact derived
   * a fresh <root>/.lucid/plan/, and the next open was segment 1, v1, zero
   * annotations - with the old record orphaned and unmentioned.
   *
   * An instruction that destroys history when followed correctly is worse
   * than the misplacement it corrects. The refusal must name BOTH moves.
   */
  test("a non-canonical artifact WITH a record names the record in the refusal too", async () => {
    const { assertCanonicalLocation } = await import("../src/core/session.ts");
    const root = await project();
    const stray = join(root, "plan.html");
    await writeFile(stray, "<!doctype html><html><body><h1>plan</h1></body></html>");
    // A real record with history beside it.
    const record = sessionPaths(stray).sessionDir;
    await mkdir(record, { recursive: true });
    await writeFile(
      join(record, "log.ndjson"),
      `${JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00Z", t: "session_opened", segment: 1, version: 1, artifact: "plan.html", hash: "h", path: "versions/s1/v1.html" })}\n`,
    );

    let message = "";
    try {
      assertCanonicalLocation(stray);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(join(root, ".lucid", "plan.html")); // the artifact
    expect(message).toContain(record); // and the record that holds the history
    expect(message).toMatch(/history|record/i);
  });

  test("a non-canonical artifact with NO record does not invent one in the message", async () => {
    const { assertCanonicalLocation } = await import("../src/core/session.ts");
    const root = await project();
    const stray = join(root, "plan.html");
    await writeFile(stray, "<!doctype html><html><body><h1>plan</h1></body></html>");

    let message = "";
    try {
      assertCanonicalLocation(stray);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(join(root, ".lucid", "plan.html"));
    // No record exists, so the message must not talk about moving one. Checked
    // on the PHRASING, not on the record path: `<root>/plan` is a substring of
    // `<root>/plan.html`, so a path check here passes for the wrong reason.
    expect(message).not.toMatch(/move BOTH|review record/i);
    expect(message).toContain("Nothing has been created here.");
  });
});

describe("the CLI open path inside a real project (plan 05, F5)", () => {
  /**
   * Every e2e fixture roots in a bare `mkdtemp` with no `.git`, so
   * `canonicalArtifactLocation` short-circuits on the no-project escape hatch
   * and the whole enforcement is invisible to the suite. That is why the hub
   * create flow and `plan render` could both ship green while emitting paths
   * their own CLI refuses. These run `runOpen` in a directory that IS a
   * project.
   */
  /**
   * DURABLE, not `tmpdir()`: `open` refuses a volatile path before it ever
   * reaches the placement check, so a /tmp fixture tests the wrong refusal.
   */
  const durableProject = async (): Promise<string> => {
    const base = join(homedir(), ".cache", "lucid-placement-tests");
    await mkdir(base, { recursive: true });
    const d = await realpath(await mkdtemp(join(base, "p-")));
    dirs.push(d);
    await mkdir(join(d, ".git"), { recursive: true });
    return d;
  };

  const runOpenIn = async (artifact: string): Promise<{ code: number; out: string }> => {
    const proc = Bun.spawn(
      [process.execPath, "run", join(import.meta.dir, "..", "src/cli/main.ts"), "open", artifact],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, LUCID_NO_OPEN: "1" } },
    );
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  };

  test("a misplaced artifact is refused end to end, and no record appears", async () => {
    const root = await durableProject();
    await mkdir(join(root, "docs"), { recursive: true });
    const stray = join(root, "docs", "plan.html");
    await writeFile(stray, "<!doctype html><html><body><h1>plan</h1></body></html>");

    const { code, out } = await runOpenIn(stray);
    expect(code).not.toBe(0);
    expect(out).toContain(join(root, ".lucid", "plan.html"));
    expect(existsSync(sessionPaths(stray).sessionDir)).toBe(false);
  });

  test("a canonical artifact opens end to end inside a project", async () => {
    const root = await durableProject();
    await mkdir(join(root, ".lucid"), { recursive: true });
    const good = join(root, ".lucid", "plan.html");
    await writeFile(good, "<!doctype html><html><body><h1>plan</h1></body></html>");

    const { code } = await runOpenIn(good);
    expect(code).toBe(0);
    expect(existsSync(sessionPaths(good).logPath)).toBe(true);
    // Stop the server this spawned so the test leaves nothing running.
    const { stopServer } = await import("../src/cli/self.ts");
    await stopServer(sessionPaths(good)).catch(() => {});
  });

  test("`lucid plan render` inside a project emits a path its own open accepts", async () => {
    const { planArtifactPath } = await import("../src/plan/render.ts");
    const root = await project();
    await mkdir(join(root, "docs"), { recursive: true });
    const doc = join(root, "docs", "notes.md");
    await writeFile(doc, "# notes\n");
    const outPath = planArtifactPath(doc);
    expect(canonicalArtifactLocation(outPath)).toEqual({ ok: true });
    expect(outPath).toBe(join(root, ".lucid", "notes.lucid.html"));
  });

  test("`lucid plan render` outside a project keeps the beside-the-doc derivation", async () => {
    const { planArtifactPath } = await import("../src/plan/render.ts");
    const d = await realpath(await mkdtemp(join(tmpdir(), "lucid-noproject-")));
    dirs.push(d);
    const doc = join(d, "notes.md");
    await writeFile(doc, "# notes\n");
    expect(planArtifactPath(doc)).toBe(join(d, "notes.lucid.html"));
  });

  test("an explicit --out is honoured even when it is not canonical", async () => {
    const { planArtifactPath } = await import("../src/plan/render.ts");
    const root = await project();
    const out = join(root, "elsewhere.html");
    expect(planArtifactPath(join(root, "notes.md"), out)).toBe(out);
  });
});
