import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Agent scratchpads: where a coding agent writes an artifact when the project
 * checkout is not where it belongs. Claude Code lays them out as
 *
 *     <tmp>/claude-<uid>/<encoded-cwd>/<session-uuid>/scratchpad/…
 *
 * where `<encoded-cwd>` is the agent's working directory with every `/` and
 * `.` flattened to `-` (`/Users/kevin/dev/sdlc` -> `-Users-kevin-dev-sdlc`).
 *
 * This matters for two reasons, and they are the same reason:
 *
 * 1. DISCOVERY. Nearly every artifact ever rendered lives in a scratchpad, not
 *    in the project it is about - so a listing that only scans project
 *    checkouts finds nothing, and a human who adds their project folder by
 *    hand still finds nothing.
 * 2. IDENTITY. A scratchpad is not a project. It is one agent session's
 *    workspace, so grouping by it labels every row "scratchpad" and says
 *    nothing about which work the review belongs to.
 *
 * Both are answered by recovering the cwd the encoding names.
 */

/** `claude-501` - the per-user bucket agent scratchpads are grouped under. */
const AGENT_BUCKET = /^claude-\d+$/;

const SCRATCHPAD = "scratchpad";

const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * One directory name from consecutive flattened segments. An EMPTY leading
 * segment is a dot: `/.orca` flattens to `--orca`, which splits to
 * ["", "", "orca"]. An empty segment anywhere else cannot come from a single
 * name, so that split is rejected rather than guessed at.
 */
const nameFrom = (parts: readonly string[]): string | undefined => {
  if (parts.length === 0) return undefined;
  const dotted = parts[0] === "";
  const body = dotted ? parts.slice(1) : parts;
  if (body.length === 0 || body.some((p) => p === "")) return undefined;
  return `${dotted ? "." : ""}${body.join("-")}`;
};

/**
 * Resolve flattened segments to a path that EXISTS, backtracking on a wrong
 * split. Shortest name first (a `-` is most often a separator), and if the
 * remainder then fails, back up and try a longer one - which is what makes
 * `…/dev/tether-private` reachable on a machine that also has `…/dev/tether`.
 */
const resolveVerified = async (
  base: string,
  parts: readonly string[],
): Promise<string | undefined> => {
  if (parts.length === 0) return base;
  for (let take = 1; take <= parts.length; take++) {
    const name = nameFrom(parts.slice(0, take));
    if (name === undefined) continue;
    const candidate = join(base, name);
    if (await isDir(candidate)) {
      const resolved = await resolveVerified(candidate, parts.slice(take));
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/**
 * Second pass, for a path that no longer fully exists: the deepest prefix that
 * IS on disk, plus whatever is left as one unverified leaf. An ephemeral
 * worktree is deleted once its work lands while the review outlives it, and
 * `…/workspaces/skillval-optimizations` names that work - where "scratchpad"
 * names nothing at all.
 *
 * Run only after `resolveVerified` fails, never instead of it: allowing a leaf
 * mid-search would let a wrong split (`tether` + `private`) win over the right
 * one that exists (`tether-private`). From the root itself this refuses - a
 * leaf anchored nowhere would be pure invention.
 */
const resolvePartial = async (
  base: string,
  parts: readonly string[],
): Promise<string | undefined> => {
  if (parts.length === 0) return base;
  for (let take = 1; take <= parts.length; take++) {
    const name = nameFrom(parts.slice(0, take));
    if (name === undefined) continue;
    const candidate = join(base, name);
    if (await isDir(candidate)) {
      const resolved = await resolvePartial(candidate, parts.slice(take));
      if (resolved !== undefined) return resolved;
    }
  }
  if (base === "/") return undefined;
  const leaf = nameFrom(parts);
  return leaf === undefined ? undefined : join(base, leaf);
};

/**
 * Recover an absolute path from its flattened form. `-` is ambiguous - it
 * encodes a path separator, a leading dot, AND a literal hyphen in a directory
 * name - so the DISK decides which reading was meant.
 *
 * Undefined only when nothing can be anchored on disk at all. (One known
 * limit: a directory whose real name contains a dot - `my.app` - flattens
 * identically to `my-app` and is not recovered.)
 */
export const decodeFlattenedPath = async (encoded: string): Promise<string | undefined> => {
  const parts = encoded.split("-");
  // A leading "-" is the root slash; anything else is not an encoded abs path.
  if (parts[0] !== "" || parts.length < 2) return undefined;
  const rest = parts.slice(1);
  return (await resolveVerified("/", rest)) ?? (await resolvePartial("/", rest));
};

/**
 * The project an artifact under an agent scratchpad belongs to, or undefined
 * when the path is not a scratchpad (or names a cwd that no longer exists).
 *
 * Takes the artifact's DIRECTORY, and tolerates nesting: agents write into
 * `scratchpad/repro/…` as readily as the scratchpad root.
 */
export const scratchpadProject = async (artifactDir: string): Promise<string | undefined> => {
  const parts = resolve(artifactDir).split("/");
  const at = parts.lastIndexOf(SCRATCHPAD);
  // Need `<bucket>/<encoded>/<session>/scratchpad`: three segments ahead of it.
  if (at < 3) return undefined;
  const encoded = parts[at - 2];
  const bucket = parts[at - 3];
  if (encoded === undefined || !encoded.startsWith("-")) return undefined;
  if (bucket === undefined || !AGENT_BUCKET.test(bucket)) return undefined;
  return decodeFlattenedPath(encoded);
};

/**
 * Scan roots holding agent scratchpads for THIS user, scanned by default:
 * without them a fresh shell shows an empty screen on a machine with a hundred
 * past reviews on disk, and the human has no way to know why.
 *
 * Returned unconditionally - `scanRoots` skips what it cannot read, so a
 * machine with no scratchpads pays one failed readdir.
 */
export const agentScratchpadRoots = (): string[] => {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  // `/private/tmp` is where these actually land on macOS; `tmpdir()` covers a
  // TMPDIR pointed somewhere else. Deduped, because usually they agree.
  return [...new Set([join("/private/tmp", `claude-${uid}`), join(tmpdir(), `claude-${uid}`)])];
};

/**
 * Directory trees the operating system empties without asking: `/tmp` and its
 * `/private` twin on macOS, plus `$TMPDIR`. macOS clears `/private/tmp` on
 * BOOT, so an artifact written there is one restart from deletion - and since
 * a session's whole history lives beside its artifact (`<dir>/.lucid/<stem>/`),
 * the annotations, versions and replies go with it.
 */
const volatileRoots = (): string[] => {
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  const t = process.env.TMPDIR;
  if (t) roots.push(resolve(t));
  return [...new Set(roots)];
};

/**
 * Is this artifact somewhere the OS will delete? Days of review work have been
 * lost to exactly this, so `lucid open` refuses rather than warns: a warning in
 * an agent's output is read by nobody, and the loss only shows up weeks later
 * when the machine restarts.
 */
export const isVolatilePath = (artifactPath: string): boolean => {
  // Deliberate opt-out for programmatic use - the test suite drives the real
  // `open` flow against temp fixtures, and a scripted one-off is entitled to
  // a throwaway artifact. Never set this in a harness: the whole point is
  // that an agent authoring into its scratchpad is stopped.
  if (process.env.LUCID_ALLOW_TEMP === "1") return false;
  const p = resolve(artifactPath);
  return volatileRoots().some((root) => p === root || p.startsWith(`${root}/`));
};
