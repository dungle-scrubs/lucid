import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { ArtifactError, ValidationError } from "../errors.ts";
import type { Warning } from "../errors.ts";
import { appendEvent, appendEventsIf, readEvents } from "./log.ts";
import type { AttendantStamp, LogEvent } from "./events.ts";
import { foldLog, type FoldedState } from "./fold.ts";
import type { SessionPaths } from "./paths.ts";
import {
  canonicalArtifactPath,
  sessionName,
  sessionPaths,
  snapshotPath,
  snapshotRelPath,
} from "./paths.ts";
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

/**
 * Is `<dir>/<stem>/` somebody ELSE's directory?
 *
 * The record is named after its artifact, so `plan.html` claims `plan/` - and a
 * human may already keep a `plan/` folder of their own right there. Writing a
 * log, a versions tree and a `*` .gitignore into it would bury their files and
 * take them out of git without a word.
 *
 * A directory Lucid already owns (it holds a log) or one that is empty is fine.
 * Anything else belongs to someone else.
 */
/**
 * Files only Lucid writes. Finding one is positive evidence that this directory
 * is a record of ours, half-built or otherwise.
 *
 * `server.out.log` and not `server.log`: `paths.ts` writes the former, and the
 * latter was a name nothing has produced since. An allowlist that has drifted
 * from its writer is worse than a short one - it refuses our own directory and
 * accepts somebody else's.
 */
const LUCID_WRITES = new Set([
  "log.ndjson",
  "log.ndjson.lock",
  "current.html",
  "versions",
  "pasted",
  "server.json",
  "server.out.log",
  "selection.json",
  "attendant.json",
  "context.json",
  "attend.out.log",
  "create.out.log",
  "run",
]);

/*
 * Deliberately absent from that list: `.gitignore` and `.DS_Store`. Both used
 * to count as ours, and neither is evidence of anything. Lucid writes a
 * `.gitignore`, and so does anybody keeping a folder out of git; the Finder
 * writes `.DS_Store` into any folder somebody opens. Treating them as proof
 * meant a placeholder folder holding one of them was read as ours and written
 * over. They now count as somebody's, which errs toward refusing - the
 * recoverable direction, since the answer names the directory and renaming it
 * takes a second.
 */

/**
 * Whether `<dir>/<stem>/` is somebody ELSE's.
 *
 * Ownership needs positive evidence, not the absence of a stranger. Deciding it
 * by "nothing here is unrecognised" made a folder holding only a `.gitignore` -
 * a placeholder somebody keeps out of git, which is a common thing to have -
 * read as ours, and Lucid then wrote its log, its versions tree and a `*`
 * .gitignore over the top of it. That is the exact harm this check exists to
 * prevent, admitted through the list meant to prevent it.
 */
const occupiedByOthers = (paths: SessionPaths): boolean => {
  if (!existsSync(paths.sessionDir)) return false;
  if (existsSync(paths.logPath)) return false; // unmistakably ours
  try {
    const entries = readdirSync(paths.sessionDir);
    if (entries.length === 0) return false; // an empty directory is nobody's
    // Ours-in-progress - a versions tree, a descriptor, a server log - reads as
    // ours. Ambient files are not counted either way.
    if (entries.some((entry) => LUCID_WRITES.has(entry))) return false;
    return true;
  } catch {
    return false; // unreadable: let the open fail on its own terms
  }
};

/**
 * The artifact a record says it belongs to, read from its log's opening event
 * (plan 05, M1.2). Sync and first-line-only: `ensureSessionDirs` runs before
 * anything else on the open path, and `session_opened` is always the first
 * event a record ever holds. Null when the record predates the stamp, is
 * unreadable, or never opened - none of which is a collision.
 */
const recordedArtifact = (logPath: string): string | null => {
  try {
    const head = readFileSync(logPath, "utf8").split("\n", 1)[0] ?? "";
    if (head.trim() === "") return null;
    const first = JSON.parse(head) as { t?: string; artifact?: unknown };
    return first.t === "session_opened" && typeof first.artifact === "string"
      ? first.artifact
      : null;
  } catch {
    return null;
  }
};

/**
 * Two artifacts whose names differ only by extension derive ONE record name -
 * `plan.html` and `plan.md` both want `<dir>/plan/` - and the existing
 * occupancy guard reads an existing log as "unmistakably ours". So the second
 * open silently appended its versions and annotations to the FIRST artifact's
 * history (D-006). The record names the artifact it belongs to; a different
 * one is a collision, and the open is refused rather than merged.
 */
const stemCollision = (paths: SessionPaths): string | null => {
  if (!existsSync(paths.logPath)) return null;
  const owner = recordedArtifact(paths.logPath);
  if (owner === null || owner === basename(paths.artifactPath)) return null;
  return owner;
};

export const ensureSessionDirs = (paths: SessionPaths): void => {
  const owner = stemCollision(paths);
  if (owner !== null) {
    throw new ValidationError({
      message:
        `refusing to open "${basename(paths.artifactPath)}": ${paths.sessionDir} is already the review record for "${owner}". ` +
        `A record is named after its artifact with the extension dropped, so these two share one name and would share one history. ` +
        `Rename one of them, or move it to its own folder, and open again.`,
      detail: { record: paths.sessionDir, owner, opening: paths.artifactPath },
    });
  }
  if (occupiedByOthers(paths)) {
    throw new ValidationError({
      message:
        `refusing to write this session's record into ${paths.sessionDir} - that directory already exists and is not a Lucid session. ` +
        `The record is named after its artifact, so "${paths.name}.html" wants "${paths.name}/". ` +
        `Rename the artifact, or move it into a folder of its own (e.g. lucid/${paths.name}.html).`,
      detail: { sessionDir: paths.sessionDir, artifact: paths.artifactPath },
    });
  }
  mkdirSync(paths.sessionDir, { recursive: true });
  mkdirSync(paths.versionsDir, { recursive: true });
  // Machine-local runtime lives here; created up front so the append lock and
  // the served copy have somewhere to land before the first write.
  mkdirSync(paths.runDir, { recursive: true });
  // The ignore file goes INSIDE the record, and names ONLY `run/` (plan 02,
  // D-003). It MUST NOT be a bare `*`: the record is now committable history,
  // and a `*` would exclude the very log and snapshots this is meant to keep -
  // the R1 untracking trap. A single `run/` line also cannot drift as new
  // machine-local sidecars are added: they land in run/ and are covered.
  const ignore = join(paths.sessionDir, ".gitignore");
  if (!existsSync(ignore)) {
    try {
      writeFileSync(ignore, "run/\n");
    } catch {
      /* self-ignoring is a courtesy; never fail a session over it */
    }
  }
};

/** Atomic write within the session dir (temp-then-rename; same-dir rename). */
export const atomicWrite = (absPath: string, content: string): void => {
  // The target may live in `run/` (plan 02), which is machine-local and absent
  // on a freshly pulled or newly mounted record. Recreate it: `run/` is derived
  // state, so rebuilding the served copy under a missing run/ is exactly right
  // (MB.3's fresh-pull-serves case). Idempotent.
  mkdirSync(dirname(absPath), { recursive: true });
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

/** The bytes of a committed snapshot (`versions/s<seg>/v<n>.html`), or undefined
 *  when it cannot be read. Unlike `current.html` this is COMMITTED, so it
 *  survives a fresh pull and is the true reconciliation baseline (MB.3). */
const readSnapshotBytes = async (
  paths: SessionPaths,
  segment: number,
  version: number,
): Promise<string | undefined> => {
  try {
    return await readFile(snapshotPath(paths, segment, version), "utf8");
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
/**
 * Refuse a realpath unification that would strand history (plan 05, M1.1, R3).
 *
 * Identity is the artifact's REAL path now, so `lucid open link.html` and
 * `lucid open plan.html` are one session. That is the fix - but if BOTH the
 * link's old record and the target's record already hold a log, opening the
 * link would silently land on the target's history and leave the link's
 * annotations addressed by nothing. Nothing is merged automatically: the open
 * refuses and names both records, so the human decides which history is the
 * real one. The single-log case (only one side has history) unifies silently,
 * which is the whole point.
 */
export const assertNoStrandedRecord = (input: string): void => {
  const literal = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
  const canonical = canonicalArtifactPath(input);
  if (literal === canonical) return; // no link in play
  // The literal record, computed WITHOUT canonicalizing - sessionPaths would
  // resolve the link right back and compare a path with itself.
  const literalLog = join(dirname(literal), sessionName(literal), "log.ndjson");
  const canonicalLog = sessionPaths(canonical).logPath;
  if (literalLog === canonicalLog) return;
  if (!existsSync(literalLog) || !existsSync(canonicalLog)) return; // at most one history
  // Both paths exist - but a parent-directory symlink (macOS /var -> /private/var)
  // makes them the SAME file seen twice, which is one record, not two.
  try {
    if (realpathSync(literalLog) === realpathSync(canonicalLog)) return;
  } catch {
    return; // unreadable: let the open fail on its own terms
  }
  throw new ValidationError({
    message:
      `refusing to open: "${input}" resolves to "${canonical}", and BOTH paths already hold a review record with history. ` +
      `A session's identity is the artifact's real path, so these would become one session - but merging two logs is not something Lucid will do behind you. ` +
      `Keep the history you want and move or delete the other record (${dirname(literalLog)} or ${dirname(canonicalLog)}), then open again.`,
    detail: { literal: literalLog, canonical: canonicalLog },
  });
};

export const openSession = async (
  paths: SessionPaths,
  opts?: { readonly attendant?: AttendantStamp },
): Promise<OpenResult> => {
  // Everything that can REFUSE runs before anything is created on disk. The
  // directory used to be made first, so a dangling symlink or an unreadable
  // file exited with a typed error and still left a `<stem>/` folder holding a
  // lone `.gitignore` beside the artifact - litter from an open that never
  // happened, and named exactly like a real record. `readEvents` tolerates a
  // missing directory, so reading the log this early costs nothing.
  const warnings: Warning[] = [];
  const before = foldLog((await readEvents(paths.logPath)).events);
  const html = await readArtifact(paths);
  const structure = validateStructure(html);
  const opening = before.status === "none" || before.status === "ended";
  if (opening && !structure.ok) {
    throw new ArtifactError({
      message: `artifact failed structural validation: ${structure.reason}`,
      detail: { path: paths.artifactPath },
    });
  }

  ensureSessionDirs(paths);

  let startedSegment = false;

  if (opening) {
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
    // ACTIVE or SUSPENDED: reconcile the artifact against the newest committed
    // SNAPSHOT (D-061, and plan 02 MB.3/D-012). NOT current.html: that is
    // machine-local (run/) and absent on a freshly pulled record, where reading
    // its absence as a change would mint a spurious version on every open. The
    // snapshot is committed history and is the true baseline; current.html is
    // only the serve cache, rebuilt below when a pull left it behind.
    const baseline = await readSnapshotBytes(paths, before.segment, before.version);
    const changed = baseline === undefined || hashContent(html) !== hashContent(baseline);
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
    } else if ((await readCurrent(paths)) === undefined) {
      // Unchanged, but the serve cache is gone (a fresh pull dropped run/).
      // Rebuild it from the artifact - which equals the baseline snapshot - so
      // the session can be served without minting a version (MB.3).
      atomicWrite(paths.currentHtml, html);
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
