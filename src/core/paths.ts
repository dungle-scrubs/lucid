import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * Resolved on-disk layout for one session. A session is identified by the
 * canonical absolute path of its artifact `<file>`; all session state lives in
 * a co-located `.lucid/<name>/` directory (see RFC §7).
 */
export interface SessionPaths {
  /** Canonical absolute path of the artifact `<file>` = the session id. */
  readonly artifactPath: string;
  /** Directory containing the artifact (also the static asset root). */
  readonly artifactDir: string;
  /** Slug derived from the artifact filename, e.g. `migration-plan`. */
  readonly name: string;
  /**
   * `<artifactDir>/<name>` - the session's own folder, beside its artifact.
   *
   * Visible, and named after the artifact it belongs to: `lucid/plan.html` is
   * reviewed, `lucid/plan/` is its record. The old layout nested a SECOND
   * `.lucid/` inside the `lucid/` folder artifacts already live in - two
   * directories one character apart, one of them hidden, and a project folder
   * that looked empty in Finder because the only thing left in it was the
   * dotted one.
   */
  readonly sessionDir: string;
  /**
   * `<sessionDir>/run` - machine-local runtime state that MUST NOT travel with
   * the record (plan 02, D-002). The served copy, the append lock, the server
   * descriptor, the out-logs and the machine-scoped sidecars all live here, so
   * a single `run/` line in the record's `.gitignore` keeps everything ELSE
   * committable and cannot drift as new sidecars are added.
   */
  readonly runDir: string;
  /** Append-only NDJSON source of truth. COMMITTED (stays under the record). */
  readonly logPath: string;
  /** Root of frozen, segment-scoped version snapshots. COMMITTED. */
  readonly versionsDir: string;
  /** Pasted-image bytes (composer uploads), addressed by `pastedRelPath`.
   *  COMMITTED. */
  readonly pastedDir: string;
  /** Lucid's served copy of `<file>` (serve + live-reload target). Derived,
   *  machine-local -> `run/`. */
  readonly currentHtml: string;
  /** This session's runtime descriptor (port + pid) for discovery. `run/`. */
  readonly serverJson: string;
  /** The detached per-session server's stdout/stderr log. `run/`. */
  readonly serverLog: string;
  /** The attend engine's per-turn output log. `run/`. */
  readonly attendLog: string;
  /** The create turn's output log. `run/`. */
  readonly createLog: string;
  /** Last-value context-usage sidecar (advisory presence, overwritten each
   *  report - never a log event, since usage updates every turn). `run/`. */
  readonly contextSidecar: string;
  /** The sticky pick sidecar (machine-scoped: a harness the other box may not
   *  have). `run/`. */
  readonly selectionPath: string;
}

/** Slugify the artifact basename (strip the final extension). */
export const sessionName = (artifactPath: string): string => {
  const base = basename(artifactPath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
};

/**
 * Resolve a (possibly relative) artifact path to its canonical absolute form -
 * symlinks included (plan 05, M1.1, #41).
 *
 * `resolve` alone normalizes `..` and relative segments but not links, so
 * `lucid open plan.html` and `lucid open link-to-plan.html` minted TWO
 * identities for one file: two records, two logs, and annotations landing in
 * whichever the last invocation picked. A session's identity is the artifact's
 * REAL path.
 *
 * An artifact `open` is about to create does not exist yet, so an unresolvable
 * file falls back to its resolved DIRECTORY plus the name, and an unresolvable
 * parent keeps the caller's own spelling - the refusal then names what the
 * human typed rather than a phantom.
 */
export const canonicalArtifactPath = (input: string): string => {
  const abs = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
  try {
    return realpathSync(abs); // the file itself, links and all
  } catch {
    // Not there (yet): `open` is about to create it, or the link dangles. The
    // DIRECTORY still resolves, which is what keeps one identity per real
    // folder; an unresolvable parent keeps the caller's own spelling so the
    // refusal names what the human typed rather than a phantom.
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
};

/**
 * The one folder artifacts live in, inside a project.
 *
 * Placement was documented (`skills/lucid/SKILL.md`) and unenforced, so an
 * agent following the pre-02 convention wrote `<project>/lucid/<name>.html`
 * and the record rule then correctly derived `<project>/lucid/.lucid/` -
 * internally consistent, wrong place, found in the wild.
 */
export const ARTIFACT_DIR = ".lucid";

/**
 * The project an artifact belongs to: the nearest enclosing directory holding
 * a `.git`, or null when there is none.
 *
 * The NEAREST, not the outermost: a package inside a monorepo keeps its own
 * `.lucid/`, which is where someone working in that package will look.
 */
export const projectRootOf = (dir: string): string | null => {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

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
  const root = projectRootOf(dirname(abs));
  if (root === null) return { ok: true };
  const canonical = join(root, ARTIFACT_DIR, basename(abs));
  return abs === canonical ? { ok: true } : { ok: false, canonical };
};

/** Compute the full session layout for an artifact path. */
export const sessionPaths = (input: string): SessionPaths => {
  const artifactPath = canonicalArtifactPath(input);
  const artifactDir = dirname(artifactPath);
  const name = sessionName(artifactPath);
  const sessionDir = resolve(artifactDir, name);
  const runDir = resolve(sessionDir, "run");
  return {
    artifactPath,
    artifactDir,
    name,
    sessionDir,
    runDir,
    // Committed - the record's history stays directly under it.
    logPath: resolve(sessionDir, "log.ndjson"),
    versionsDir: resolve(sessionDir, "versions"),
    pastedDir: resolve(sessionDir, "pasted"),
    // Machine-local - everything derived or per-machine lives under run/.
    currentHtml: resolve(runDir, "current.html"),
    serverJson: resolve(runDir, "server.json"),
    serverLog: resolve(runDir, "server.out.log"),
    attendLog: resolve(runDir, "attend.out.log"),
    createLog: resolve(runDir, "create.out.log"),
    contextSidecar: resolve(runDir, "context.json"),
    selectionPath: resolve(runDir, "selection.json"),
  };
};

/** Segment-scoped snapshot path, e.g. `versions/s2/v3.html` (D-050). */
export const snapshotPath = (paths: SessionPaths, segment: number, version: number): string =>
  resolve(paths.versionsDir, `s${segment}`, `v${version}.html`);

/** Relative snapshot path recorded inside log events, e.g. `versions/s2/v3.html`. */
export const snapshotRelPath = (segment: number, version: number): string =>
  `versions/s${segment}/v${version}.html`;

/** Session-relative path of a pasted image, e.g. `pasted/a1b2.png`. */
export const pastedRelPath = (file: string): string => `pasted/${file}`;

/** Advisory per-harness cursor sidecar path (D-051). */
export const cursorSidecarPath = (paths: SessionPaths, harness: string): string => {
  const safe = harness.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Machine-scoped (harness availability differs per machine), so `run/`.
  return resolve(paths.runDir, `cursor.${safe}.json`);
};
