import { existsSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ARTIFACT_DIR, canonicalArtifactPath, type SessionPaths } from "./paths.ts";
import { scratchpadProject } from "./scratchpad.ts";

/**
 * The project an artifact belongs to, and where it belongs inside it.
 *
 * One question with four right answers, which is why it has one owner: the
 * folder walk, the `.lucid` fallback, the git-worktree resolution and the
 * scratchpad decode were each spelled where they were first needed, and the
 * spellings drifted - the same artifact was grouped under one project by the
 * hub and treated as belonging to another by the attend engine, which then
 * handed the human's feedback to a stranger.
 *
 * The dependency runs one way, `project.ts` -> `paths.ts`, and must keep
 * running one way: `paths.ts` is loaded by every entrypoint, so an import cycle
 * between the two is a startup crash waiting for the first module-scope
 * constant either side derives from the other.
 */

/**
 * The nearest enclosing checkout of `dir`, or null when there is none.
 *
 * The NEAREST, not the outermost: a package inside a monorepo keeps its own
 * `.lucid/`, which is where someone working in that package will look.
 */
export const enclosingCheckout = (dir: string): string | null => {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/**
 * The checkout an artifact SITS in: the nearest enclosing one, or - when there
 * is none above it - the folder the artifact sits in.
 *
 * With one exception, and it is structural rather than a heuristic: `.lucid` is
 * LUCID's folder inside a project, never a project itself. In the canonical
 * layout the artifact lives at `<project>/.lucid/<name>.html`, so the fallback
 * landed on `.lucid` for any project without a `.git` - and the listing then
 * grouped those reviews under a heading called ".lucid", which names Lucid's
 * own plumbing rather than the human's work.
 */
export const artifactCheckout = (paths: SessionPaths): string =>
  enclosingCheckout(paths.artifactDir) ??
  (basename(paths.artifactDir) === ARTIFACT_DIR ? dirname(paths.artifactDir) : paths.artifactDir);

/**
 * The checkout a working directory belongs to: the nearest enclosing one, or -
 * outside any checkout - the directory itself.
 *
 * Both sides of "did this artifact move projects?" go through THIS, because a
 * comparison is only as good as its symmetry. Normalizing one side and not the
 * other made an agent working in `<repo>/packages/app` look like it had moved
 * away from `<repo>` - and an artifact that moved gets a fresh handoff, so the
 * human's feedback reached a stranger for every agent whose cwd was a
 * subdirectory of its own repo.
 */
export const checkoutOf = (dir: string): string => enclosingCheckout(dir) ?? dir;

/**
 * Is this artifact where artifacts go (plan 05, M3.2, D-011)?
 *
 * Judged against the artifact's own project root, NOT against `sessionPaths` -
 * the record-beside-artifact rule is correct and unchanged; this is the
 * separate question of where the ARTIFACT itself belongs.
 *
 * A path outside any project is ok, and that absence IS the escape hatch
 * (D-015): an agent scratchpad has no root to be canonical against, and D-022's
 * ephemeral records already live there. There is no opt-out flag.
 */
export const canonicalArtifactLocation = (
  artifactPath: string,
): { ok: true } | { ok: false; canonical: string } => {
  const abs = canonicalArtifactPath(artifactPath);
  const root = enclosingCheckout(dirname(abs));
  if (root === null) return { ok: true };
  const canonical = join(root, ARTIFACT_DIR, basename(abs));
  if (abs === canonical) return { ok: true };
  // Sameness is the filesystem's to decide, not the string's. APFS is
  // case-insensitive, so a project whose folder is really named `.Lucid`
  // produced a demand nothing could satisfy: the canonical path already WAS
  // the file, `mkdir .lucid` failed EEXIST, and querying the lowercase
  // spelling realpath'd straight back to `.Lucid`. Compared on the DIRECTORY,
  // because the basenames are equal by construction above and the artifact
  // may not exist yet - `open` is often about to create it.
  try {
    if (realpathSync(dirname(abs)) === realpathSync(dirname(canonical))) return { ok: true };
  } catch {
    /* the canonical folder does not exist yet: a genuine move is needed */
  }
  return { ok: false, canonical };
};

/** Where an artifact belongs, and where work on it runs. */
export interface Project {
  /** The grouping root: a worktree resolved to its main repo, a scratchpad
   *  decoded to the checkout the agent was working on. */
  readonly project: string;
  /** Where a harness runs for this artifact. Unlike `project` this is a real
   *  checkout on disk: a worktree stays itself, because that is where the work
   *  is. */
  readonly checkout: string;
  /** Names the checkout when it differs from the grouping root. */
  readonly worktree?: string;
}

/**
 * Group a checkout, worktree-aware: a git WORKTREE's `.git` is a file pointing
 * at `<main>/.git/worktrees/<name>`, and the drawer groups worktrees under
 * their MAIN repo even though they live in other directories.
 */
const groupingFor = async (root: string): Promise<{ project: string; worktree?: string }> => {
  try {
    const gitPath = join(root, ".git");
    if ((await stat(gitPath)).isFile()) {
      const raw = await readFile(gitPath, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(raw);
      if (m?.[1]) {
        const gitdir = resolve(root, m[1].trim());
        const wt = /^(.*)[/]\.git[/]worktrees[/][^/]+[/]?$/.exec(gitdir);
        if (wt?.[1]) return { project: wt[1], worktree: root };
      }
    }
  } catch {
    /* plain .git directory, or unreadable: the root is the project */
  }
  return { project: root };
};

/**
 * The project an artifact belongs to, and the checkout work on it runs in.
 *
 * An artifact in an agent's scratchpad belongs to the project that agent was
 * WORKING ON, not to the scratchpad - which is one session's workspace and
 * would label every such row "scratchpad". The decoded cwd then goes through
 * the same worktree resolution as any checkout, because a cwd is routinely a
 * worktree.
 */
export const projectOf = async (paths: SessionPaths): Promise<Project> => {
  const decoded = await scratchpadProject(paths.artifactDir);
  const checkout = decoded ?? artifactCheckout(paths);
  const grouped = await groupingFor(checkout);
  return {
    project: grouped.project,
    checkout,
    ...(grouped.worktree !== undefined ? { worktree: grouped.worktree } : {}),
  };
};
