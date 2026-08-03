import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPaths } from "../src/core/paths.ts";
import { artifactCheckout, checkoutOf, enclosingCheckout, projectOf } from "../src/core/project.ts";

/**
 * The owner of "which project does this artifact belong to" (`core/project.ts`).
 *
 * The question has four right answers - the folder walk, the `.lucid` fallback,
 * the worktree resolution, the scratchpad decode - and they used to be spelled
 * once per caller. The hub then grouped an artifact under one project while the
 * attend engine treated it as belonging to another, and the human's feedback
 * went to a stranger. These are the rules themselves, tested where they live
 * rather than through whichever caller happens to reach them.
 */

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-project-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A checkout: a directory with a real `.git` directory in it. */
const checkout = async (...segments: string[]): Promise<string> => {
  const root = join(dir, ...segments);
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
};

/** A linked worktree: `.git` is a FILE pointing into the main repo's admin
 *  directory, which is how git actually spells one on disk. */
const worktreeOf = async (main: string, name: string): Promise<string> => {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".git"), `gitdir: ${join(main, ".git", "worktrees", name)}\n`);
  return root;
};

/** An artifact in the scratchpad of an agent whose cwd was `agentCwd`, laid
 *  out the way Claude Code lays one out (`/` and `.` both flattened to `-`). */
const scratchpadArtifact = async (agentCwd: string): Promise<string> => {
  const encoded = agentCwd.replaceAll("/", "-").replaceAll(".", "-");
  const pad = join(
    dir,
    "claude-501",
    encoded,
    "1ca9d3f0-0000-4000-8000-000000000001",
    "scratchpad",
  );
  await mkdir(pad, { recursive: true });
  const artifact = join(pad, "plan.html");
  await writeFile(artifact, "<html></html>");
  return artifact;
};

describe("enclosingCheckout", () => {
  test("finds the NEAREST checkout, so a package in a monorepo keeps its own", async () => {
    const outer = await checkout("outer");
    const inner = await checkout("outer", "packages", "inner");
    expect(enclosingCheckout(join(inner, "src"))).toBe(inner);
    expect(enclosingCheckout(join(outer, "docs"))).toBe(outer);
  });

  test("is null outside any checkout, which is what makes the fallbacks reachable", async () => {
    const loose = join(dir, "loose");
    await mkdir(loose, { recursive: true });
    expect(enclosingCheckout(loose)).toBeNull();
  });
});

describe("checkoutOf", () => {
  test("a directory inside a checkout answers with the checkout", async () => {
    const repo = await checkout("repo");
    const pkg = join(repo, "packages", "app");
    await mkdir(pkg, { recursive: true });
    // Both sides of "did this artifact move projects?" go through this, so a
    // cwd below its own repo root must compare equal to that root.
    expect(checkoutOf(pkg)).toBe(repo);
  });

  test("a directory outside every checkout answers with itself", async () => {
    const loose = join(dir, "loose");
    await mkdir(loose, { recursive: true });
    expect(checkoutOf(loose)).toBe(loose);
  });
});

describe("artifactCheckout", () => {
  test("the canonical artifact sits in its project's .lucid folder", async () => {
    const repo = await checkout("repo");
    const paths = sessionPaths(join(repo, ".lucid", "plan.html"));
    expect(artifactCheckout(paths)).toBe(repo);
  });

  test("without a checkout above it, `.lucid` names Lucid's plumbing, not a project", async () => {
    const loose = join(dir, "loose");
    await mkdir(join(loose, ".lucid"), { recursive: true });
    const paths = sessionPaths(join(loose, ".lucid", "plan.html"));
    expect(artifactCheckout(paths)).toBe(loose);
  });

  test("an artifact loose on disk falls back to the folder it sits in", async () => {
    const notes = join(dir, "notes");
    await mkdir(notes, { recursive: true });
    const paths = sessionPaths(join(notes, "plan.html"));
    expect(artifactCheckout(paths)).toBe(notes);
  });
});

describe("projectOf", () => {
  test("groups a worktree under its main repo while the checkout stays the worktree", async () => {
    const main = await checkout("main");
    const wt = await worktreeOf(main, "wt");
    // The split the drawer and the attend engine each need a different half of:
    // group the review with the repo it belongs to, run the work where it is.
    expect(await projectOf(sessionPaths(join(wt, ".lucid", "plan.html")))).toEqual({
      project: main,
      checkout: wt,
      worktree: wt,
    });
  });

  test("a plain checkout is its own project, with no worktree named", async () => {
    const repo = await checkout("repo");
    expect(await projectOf(sessionPaths(join(repo, ".lucid", "plan.html")))).toEqual({
      project: repo,
      checkout: repo,
    });
  });

  test("a scratchpad artifact belongs to the checkout its path encodes", async () => {
    const repo = await checkout("dev", "proj");
    const artifact = await scratchpadArtifact(repo);
    // Not to the scratchpad: that is one agent session's workspace, and
    // grouping by it labels every such review "scratchpad".
    expect(await projectOf(sessionPaths(artifact))).toEqual({ project: repo, checkout: repo });
  });

  test("a scratchpad that decodes to a worktree still groups under the main repo", async () => {
    const main = await checkout("main");
    const wt = await worktreeOf(main, "wt");
    const artifact = await scratchpadArtifact(wt);
    // The decode and the worktree resolution compose, because an agent's cwd
    // is routinely a worktree.
    expect(await projectOf(sessionPaths(artifact))).toEqual({
      project: main,
      checkout: wt,
      worktree: wt,
    });
  });

  test("a scratchpad naming a checkout that is gone still names the work", async () => {
    const repo = await checkout("dev", "proj");
    const artifact = await scratchpadArtifact(repo);
    await rm(repo, { recursive: true, force: true });
    // An ephemeral worktree is deleted once its work lands while the review
    // outlives it. `…/dev/proj` names that work; "scratchpad" names nothing.
    expect(await projectOf(sessionPaths(artifact))).toEqual({ project: repo, checkout: repo });
  });
});
