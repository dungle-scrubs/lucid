import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ArtifactError } from "../errors.ts";
import type { Warning } from "../errors.ts";
import { appendEvent, appendEventsIf, readEvents } from "./log.ts";
import type { AttendantStamp, LogEvent } from "./events.ts";
import { foldLog, type FoldedState } from "./fold.ts";
import type { SessionPaths } from "./paths.ts";
import { snapshotPath, snapshotRelPath } from "./paths.ts";
import { hashContent, validateStructure, writeSnapshot } from "./version.ts";

/**
 * Ensure the session directory tree exists, and that it ignores itself.
 *
 * Session state is Lucid's machinery - a log, an advisory lock, a served copy,
 * version snapshots, pasted bytes - and it lands next to the artifact, which is
 * often inside someone's repo. Left alone it shows up in `git status` as a
 * lockfile and a server log nobody asked for, so `.lucid/` carries its own
 * `.gitignore` rather than asking every user to discover the problem and patch
 * their root .gitignore by hand.
 *
 * Written whenever it is absent, not only for a brand-new `.lucid/`: sessions
 * that predate this behaviour are exactly the ones already polluting a repo.
 * An existing file is never touched, so a team that wants part of the record
 * committed edits it (`!log.ndjson`) and keeps that forever.
 */
export const ensureSessionDirs = (paths: SessionPaths): void => {
  const lucidRoot = dirname(paths.sessionDir);
  mkdirSync(paths.sessionDir, { recursive: true });
  mkdirSync(paths.versionsDir, { recursive: true });
  const ignore = join(lucidRoot, ".gitignore");
  if (!existsSync(ignore)) {
    try {
      writeFileSync(ignore, "*\n");
    } catch {
      /* self-ignoring is a courtesy; never fail a session over it */
    }
  }
};

/** Atomic write within the session dir (temp-then-rename; same-dir rename). */
export const atomicWrite = (absPath: string, content: string): void => {
  const tmp = `${absPath}.tmp.${process.pid}`;
  writeSnapshot(tmp, content);
  renameSync(tmp, absPath);
};

/** Read the agent's artifact file; ARTIFACT_ERROR if unreadable. */
export const readArtifact = async (paths: SessionPaths): Promise<string> => {
  try {
    return await readFile(paths.artifactPath, "utf8");
  } catch (err) {
    throw new ArtifactError({
      message: `cannot read artifact: ${(err as Error).message}`,
      detail: { path: paths.artifactPath },
    });
  }
};

const readCurrent = async (paths: SessionPaths): Promise<string | undefined> => {
  try {
    return await readFile(paths.currentHtml, "utf8");
  } catch {
    return undefined;
  }
};

export interface VersionCommit {
  readonly version: number;
  readonly hash: string;
  readonly path: string;
}

/**
 * Commit a version's bytes crash-safely (D-024): write the segment-scoped
 * snapshot (+fsync), then update `current.html` (the serve target). The caller
 * appends the `version`/`session_opened` event AFTER this returns.
 */
export const commitVersionBytes = (
  paths: SessionPaths,
  html: string,
  segment: number,
  version: number,
): VersionCommit => {
  const snapAbs = snapshotPath(paths, segment, version);
  writeSnapshot(snapAbs, html);
  atomicWrite(paths.currentHtml, html);
  return { version, hash: hashContent(html), path: snapshotRelPath(segment, version) };
};

export interface OpenResult {
  readonly state: FoldedState;
  /** Opening cursor seq the authoring agent persists (D-040). */
  readonly cursor: number;
  readonly warnings: readonly Warning[];
  /** True when this open started or re-opened a lifecycle segment. */
  readonly startedSegment: boolean;
}

/**
 * Open / resume / re-segment a session at the log level (no server). Handles:
 *  - fresh open (status none): segment 1, commit v1, session_opened
 *  - re-open on ENDED: new segment, commit v1, session_opened (D-045)
 *  - resume on SUSPENDED: reconcile file vs current.html, session_resumed (D-061)
 *  - idempotent open on ACTIVE: reconcile only
 */
export const openSession = async (
  paths: SessionPaths,
  opts?: { readonly attendant?: AttendantStamp },
): Promise<OpenResult> => {
  ensureSessionDirs(paths);
  const warnings: Warning[] = [];
  const before = foldLog((await readEvents(paths.logPath)).events);
  const html = await readArtifact(paths);
  const structure = validateStructure(html);

  let startedSegment = false;

  if (before.status === "none" || before.status === "ended") {
    if (!structure.ok) {
      throw new ArtifactError({
        message: `artifact failed structural validation: ${structure.reason}`,
        detail: { path: paths.artifactPath },
      });
    }
    const segment = before.status === "none" ? 1 : before.segment + 1;
    const commit = commitVersionBytes(paths, html, segment, 1);
    await appendEvent(paths.logPath, {
      t: "session_opened",
      segment,
      artifact: basename(paths.artifactPath),
      version: 1,
      hash: commit.hash,
      path: commit.path,
      ...(opts?.attendant ? { attendant: opts.attendant } : {}),
    });
    startedSegment = true;
  } else {
    // ACTIVE or SUSPENDED: reconcile the file against current.html (D-061).
    const current = await readCurrent(paths);
    const changed = current === undefined || hashContent(html) !== hashContent(current);
    if (changed) {
      if (structure.ok) {
        const nextVersion = before.version + 1;
        const commit = commitVersionBytes(paths, html, before.segment, nextVersion);
        await appendEvent(paths.logPath, {
          t: "version",
          version: nextVersion,
          hash: commit.hash,
          path: commit.path,
          // The opener made this revision happen (their edit is what differs
          // from current.html), so the reconciliation version keeps their
          // provenance. Watcher-driven commits stay unstamped until attend
          // mode knows whose turn produced them.
          ...(opts?.attendant ? { attendant: opts.attendant } : {}),
        });
      } else {
        warnings.push({
          code: "STRUCTURE_INVALID",
          message: `artifact change ignored on resume: ${structure.reason}`,
          detail: { path: paths.artifactPath },
        });
      }
    }
    if (before.status === "suspended") {
      await appendEvent(paths.logPath, {
        t: "session_resumed",
        segment: before.segment,
        ...(opts?.attendant ? { attendant: opts.attendant } : {}),
      });
    }
  }

  const state = foldLog((await readEvents(paths.logPath)).events);
  return { state, cursor: state.highSeq, warnings, startedSegment };
};

/**
 * Commit a watcher-detected artifact change as a new version, if the settled
 * file is structurally valid and actually differs from current.html. Returns
 * the appended `version` event (so callers can broadcast the real persisted
 * event rather than a synthetic one) or a warning.
 *
 * The status check and the version append run atomically under the exclusive
 * log lock (D-049) via `appendEventsIf`, so a concurrent
 * `session_suspended`/`session_ended` cannot land a `version` event in a
 * just-closed segment.
 */
export const commitWatchedChange = async (
  paths: SessionPaths,
): Promise<{ committed?: LogEvent; warning?: Warning }> => {
  const html = await readArtifact(paths);
  const structure = validateStructure(html);
  if (!structure.ok) {
    return {
      warning: {
        code: "STRUCTURE_INVALID",
        message: `artifact change not committed: ${structure.reason}`,
        detail: { path: paths.artifactPath },
      },
    };
  }
  const current = await readCurrent(paths);
  if (current !== undefined && hashContent(html) === hashContent(current)) {
    return {}; // no real change
  }
  // The version number and segment are derived from the current fold; the
  // status gate is re-checked atomically inside the lock by appendEventsIf so a
  // concurrent suspend/end cannot let this version land in a closed segment.
  const before = foldLog((await readEvents(paths.logPath)).events);
  const nextVersion = before.version + 1;
  const commit = commitVersionBytes(paths, html, before.segment, nextVersion);
  const events = await appendEventsIf(
    paths.logPath,
    (existing) => foldLog(existing).status === "active",
    [{ t: "version", version: nextVersion, hash: commit.hash, path: commit.path }],
  );
  return events.length > 0 ? { committed: events[0] } : {};
};
