import { basename, dirname, extname, isAbsolute, resolve } from "node:path";

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
  /** Where a session's folder used to live, `<artifactDir>/.lucid/<name>`.
   *  Kept so an existing session can be found and moved forward exactly once. */
  readonly legacySessionDir: string;
  /** Append-only NDJSON source of truth. */
  readonly logPath: string;
  /** Lucid's served copy of `<file>` (serve + live-reload target). */
  readonly currentHtml: string;
  /** Root of frozen, segment-scoped version snapshots. */
  readonly versionsDir: string;
  /** Pasted-image bytes (composer uploads), addressed by `pastedRelPath`. */
  readonly pastedDir: string;
  /** This session's runtime descriptor (port + pid) for discovery. */
  readonly serverJson: string;
  /** The detached per-session server's stdout/stderr log. */
  readonly serverLog: string;
  /** Last-value context-usage sidecar (advisory presence, overwritten each
   *  report - never a log event, since usage updates every turn). */
  readonly contextSidecar: string;
}

/** Slugify the artifact basename (strip the final extension). */
export const sessionName = (artifactPath: string): string => {
  const base = basename(artifactPath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
};

/** Resolve a (possibly relative) artifact path to its canonical absolute form. */
export const canonicalArtifactPath = (input: string): string =>
  isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);

/** Compute the full session layout for an artifact path. */
export const sessionPaths = (input: string): SessionPaths => {
  const artifactPath = canonicalArtifactPath(input);
  const artifactDir = dirname(artifactPath);
  const name = sessionName(artifactPath);
  const sessionDir = resolve(artifactDir, name);
  return {
    artifactPath,
    artifactDir,
    name,
    sessionDir,
    legacySessionDir: resolve(artifactDir, ".lucid", name),
    logPath: resolve(sessionDir, "log.ndjson"),
    currentHtml: resolve(sessionDir, "current.html"),
    versionsDir: resolve(sessionDir, "versions"),
    pastedDir: resolve(sessionDir, "pasted"),
    serverJson: resolve(sessionDir, "server.json"),
    serverLog: resolve(sessionDir, "server.out.log"),
    contextSidecar: resolve(sessionDir, "context.json"),
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
  return resolve(paths.sessionDir, `cursor.${safe}.json`);
};
