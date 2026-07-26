import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentScratchpadRoots,
  decodeFlattenedPath,
  scratchpadProject,
} from "../src/core/scratchpad.ts";

/**
 * Decoding an agent scratchpad path back to the project it belongs to. The
 * encoding is lossy (`/`, `.` and a literal `-` all become `-`), so every case
 * here is really a question about what the DISK says.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-scratch-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Flatten a real path the way Claude Code does, so tests state the input the
 *  way it actually arrives rather than hand-writing dashes. */
const flatten = (path: string): string => path.replaceAll("/", "-").replaceAll(".", "-");

describe("decodeFlattenedPath", () => {
  test("recovers a plain path", async () => {
    const project = join(dir, "dev", "sdlc");
    await mkdir(project, { recursive: true });
    expect(await decodeFlattenedPath(flatten(project))).toBe(project);
  });

  test("a hyphen INSIDE a directory name survives, because the disk decides", async () => {
    // `-dev-readyagent-readyagent-backend` could split either way; only one of
    // them exists.
    const project = join(dir, "dev", "readyagent", "readyagent-backend");
    await mkdir(project, { recursive: true });
    expect(await decodeFlattenedPath(flatten(project))).toBe(project);
  });

  test("a dot-directory arrives as an empty segment and is restored", async () => {
    // `/.orca/` flattens to `--orca-`: the empty segment is the dot.
    const project = join(dir, ".orca", "workspaces", "skillval-optimizations");
    await mkdir(project, { recursive: true });
    expect(await decodeFlattenedPath(flatten(project))).toBe(project);
  });

  test("backtracks off a wrong split: `tether-private` beside an existing `tether`", async () => {
    // The shortest-first guess lands on `tether`, whose remainder cannot
    // resolve; without backtracking this whole path was abandoned.
    await mkdir(join(dir, "dev", "tether"), { recursive: true });
    const project = join(dir, "dev", "tether-private");
    await mkdir(project, { recursive: true });
    expect(await decodeFlattenedPath(flatten(project))).toBe(project);
  });

  test("a directory deleted since keeps its name as an unverified leaf", async () => {
    // Ephemeral worktrees are removed once the work lands, and the review
    // outlives them. The parent anchors the decode; the leaf is still the name
    // of the work, which beats collapsing to the scratchpad.
    const parent = join(dir, ".orca", "workspaces");
    await mkdir(parent, { recursive: true });
    expect(await decodeFlattenedPath(flatten(join(parent, "skillval-optimizations")))).toBe(
      join(parent, "skillval-optimizations"),
    );
  });

  test("nothing anchored on disk is refused rather than invented", async () => {
    expect(await decodeFlattenedPath("-nope-nothing-here")).toBeUndefined();
  });

  test("a relative encoding is refused", async () => {
    expect(await decodeFlattenedPath("Users-kevin-dev")).toBeUndefined();
    expect(await decodeFlattenedPath("")).toBeUndefined();
  });
});

describe("scratchpadProject", () => {
  /** `<bucket>/claude-<uid>/<encoded-cwd>/<session>/scratchpad` */
  const scratchpadFor = (project: string, extra = ""): string =>
    join(
      dir,
      "claude-501",
      flatten(project),
      "40c9c345-b638-4286-bfce-796d9e6fad98",
      "scratchpad",
      extra,
    );

  test("an artifact in a scratchpad belongs to the cwd the path encodes", async () => {
    const project = join(dir, "dev", "sdlc");
    await mkdir(project, { recursive: true });
    expect(await scratchpadProject(scratchpadFor(project))).toBe(project);
  });

  test("nesting under the scratchpad still resolves - agents write subfolders", async () => {
    const project = join(dir, "dev", "lucid");
    await mkdir(project, { recursive: true });
    expect(await scratchpadProject(scratchpadFor(project, "repro"))).toBe(project);
  });

  test("an ordinary project directory is not a scratchpad", async () => {
    const project = join(dir, "dev", "lucid");
    await mkdir(project, { recursive: true });
    expect(await scratchpadProject(project)).toBeUndefined();
  });

  test("a `scratchpad` folder that is not under an agent bucket is left alone", async () => {
    // Someone's own ~/dev/thing/scratchpad is a normal directory, not an
    // encoded cwd - guessing a project for it would be worse than grouping it
    // where it sits.
    const plain = join(dir, "dev", "thing", "sessions", "scratchpad");
    await mkdir(plain, { recursive: true });
    expect(await scratchpadProject(plain)).toBeUndefined();
  });

  test("a scratchpad whose project was deleted still names that project", async () => {
    await mkdir(join(dir, "dev"), { recursive: true });
    const gone = join(dir, "dev", "vanished");
    expect(await scratchpadProject(scratchpadFor(gone))).toBe(gone);
  });
});

describe("agentScratchpadRoots", () => {
  test("names this user's buckets, so past reviews are found with no setup", () => {
    const roots = agentScratchpadRoots();
    const uid = process.getuid?.();
    expect(uid).toBeDefined();
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((r) => r.endsWith(`claude-${uid}`))).toBe(true);
    // Deduped: /private/tmp and tmpdir() usually agree on macOS.
    expect(new Set(roots).size).toBe(roots.length);
  });
});
