import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "./atomic-json.ts";
import { cleanStampField, sanitizeAttendant, type SessionIdAuthority } from "./events.ts";
import { withAppendLock } from "./lock.ts";
import { cursorSidecarPath, type SessionPaths } from "./paths.ts";

/**
 * The advisory per-harness sidecar (D-051), grown into an identity record: who
 * last attended this review, and - when the harness supplied one - the exact
 * command that resumes its conversation. The command is data to display and
 * copy, never something Lucid executes: re-invocation stays external (D-064),
 * in the human's terminal, with the human's hands on it.
 */
export interface Attendant {
  readonly harness: string;
  /** Optional since native identity landed: a PENDING pre-open sidecar holds
   *  identity discovered before the review log exists, and has no delivery
   *  cursor to record yet. */
  readonly nextCursor?: string;
  readonly at: string;
  /** Ready-to-paste command that resumes the harness conversation. */
  readonly resume?: string;
  /** Model the attending session runs on (from its environment), display data
   *  for the viewer's inherited pickers. */
  readonly model?: string;
  /** Effort/reasoning level the attending session runs at, same provenance. */
  readonly effort?: string;
  /** The harness-native session id, recorded EXPLICITLY - resume resolution
   *  reads this field, never a parse of the `resume` string. */
  readonly sessionId?: string;
  /** Who vouches for `sessionId`; absent means the id is display data only
   *  and never a tier-one resume candidate. */
  readonly sessionIdAuthority?: SessionIdAuthority;
  /** The launch that produced this identity - correlation, never resumable. */
  readonly launchId?: string;
  /** Identity discovered before `session_opened`: the durable binding is
   *  still owed to the log, promoted immediately after open. */
  readonly pendingBinding?: boolean;
  /** Native ids this MACHINE proved dead (HSI004), newest last, bounded to
   *  MAX_SESSION_INVALIDATIONS. Resolution skips them; a restart must not
   *  retry an id the harness already said does not exist. */
  readonly invalidatedSessionIds?: readonly string[];
}

export const MAX_SESSION_INVALIDATIONS = 8;

/** Normalize a sidecar record with the SAME rules the log's stamp normalizer
 *  enforces - by CALLING it, not copying it: the sidecar feeds resume argv,
 *  and the two normalizers drifting apart is how the log and the sidecar
 *  come to disagree about session identity. The stamp subset (harness,
 *  sessionId, authority, launchId, model, effort) goes through
 *  sanitizeAttendant; only the sidecar-native fields are handled here. */
const normalizeAttendant = (value: unknown): Attendant | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const stamp = sanitizeAttendant(o);
  const at = cleanStampField(o.at, 64);
  if (!stamp || !at) return undefined;
  // The stamp's cwd/trace are log-event concerns; the sidecar does not carry
  // them, and keeping them would grow the file with fields no reader uses.
  const { cwd: _cwd, trace: _trace, ...identity } = stamp;
  const nextCursor = cleanStampField(o.nextCursor, 64);
  const resume = cleanStampField(o.resume, 1024);
  const invalidatedSessionIds = Array.isArray(o.invalidatedSessionIds)
    ? o.invalidatedSessionIds
        .map((id) => cleanStampField(id, 128))
        .filter((id): id is string => id !== undefined)
        .slice(-MAX_SESSION_INVALIDATIONS)
    : undefined;
  // A pending binding is a PROMISE that promotion can keep: it requires the
  // full identity (id + authority + launch). Anything less is not "pending",
  // it is nothing - normalization drops the flag rather than letting an
  // impossible state reach a reader that would have to re-prove it.
  const pendingBinding =
    o.pendingBinding === true &&
    identity.sessionId !== undefined &&
    identity.sessionIdAuthority !== undefined &&
    identity.launchId !== undefined;
  return {
    ...identity,
    at,
    ...(nextCursor ? { nextCursor } : {}),
    ...(resume ? { resume } : {}),
    ...(pendingBinding ? { pendingBinding: true } : {}),
    ...(invalidatedSessionIds && invalidatedSessionIds.length > 0 ? { invalidatedSessionIds } : {}),
  };
};

/**
 * The ONE sidecar writer: read, normalize, apply the caller's merge, normalize
 * again, publish atomically - all under the per-harness lock. Every writer
 * used to construct-and-clobber, so the agent's wait turn and the launcher
 * erased each other's fields, and a reader could catch half a JSON document.
 * The lock serializes writers; the tmp-then-rename publish means a reader
 * sees the old complete document or the new complete document, never a torn
 * one.
 */
export const mutateAttendantSidecar = async (
  paths: SessionPaths,
  harness: string,
  mutate: (current: Attendant | undefined) => Attendant,
): Promise<Attendant> => {
  const target = cursorSidecarPath(paths, harness);
  return withAppendLock(target, async () => {
    let current: Attendant | undefined;
    try {
      current = normalizeAttendant(JSON.parse(await readFile(target, "utf8")));
    } catch {
      current = undefined; // absent or advisory-data-gone-bad: start fresh
    }
    const next = normalizeAttendant(mutate(current));
    if (!next) {
      throw new Error(`attendant mutation for "${harness}" produced an invalid record`);
    }
    await writeJsonFile(target, next);
    return next;
  });
};

/** MERGE the sidecar: fields the caller names are updated, fields it does not
 *  name survive. (The launcher's narrow stamp used to erase the agent's
 *  resume command; a merge cannot.) Named for what it does - a caller that
 *  needs to REMOVE a field builds the full record through
 *  mutateAttendantSidecar instead. */
export const mergeAttendantSidecar = async (
  paths: SessionPaths,
  attendant: Attendant,
): Promise<void> => {
  await mutateAttendantSidecar(paths, attendant.harness, (current) => ({
    ...current,
    ...attendant,
  }));
};

/** Record identity discovered BEFORE the review log exists. The sidecar holds
 *  it as pending; promotion appends the durable binding right after
 *  `session_opened` and clears the flag. */
export const recordPendingIdentity = async (
  paths: SessionPaths,
  identity: {
    readonly harness: string;
    readonly sessionId: string;
    readonly sessionIdAuthority: SessionIdAuthority;
    readonly launchId: string;
  },
): Promise<Attendant> =>
  mutateAttendantSidecar(paths, identity.harness, (current) => ({
    ...current,
    harness: identity.harness,
    at: new Date().toISOString(),
    sessionId: identity.sessionId,
    sessionIdAuthority: identity.sessionIdAuthority,
    launchId: identity.launchId,
    pendingBinding: true,
  }));

/** Persist "this native id does not exist on this machine" (HSI004): deduped,
 *  newest last, bounded - and durable across engine restarts, which is the
 *  point: the harness said no once; asking again is not a retry, it is a
 *  loop. */
export const recordSessionInvalidation = async (
  paths: SessionPaths,
  harness: string,
  sessionId: string,
): Promise<Attendant> =>
  mutateAttendantSidecar(paths, harness, (current) => ({
    harness,
    at: current?.at ?? new Date().toISOString(),
    ...current,
    invalidatedSessionIds: [
      ...(current?.invalidatedSessionIds ?? []).filter((id) => id !== sessionId),
      sessionId,
    ].slice(-MAX_SESSION_INVALIDATIONS),
  }));

/** Scan every `cursor.<harness>.json` sidecar, NORMALIZED - one scanner, one
 *  parser, so the read path that feeds resume is held to the same standard as
 *  the write path. Unreadable or invalid files are advisory data gone bad and
 *  are skipped, which also absorbs any torn read from a pre-atomic writer. */
const readSidecars = async (paths: SessionPaths): Promise<Attendant[]> => {
  let names: string[];
  try {
    names = await readdir(paths.runDir);
  } catch {
    return [];
  }
  const records: Attendant[] = [];
  for (const name of names) {
    if (!/^cursor\..+\.json$/.test(name)) continue;
    try {
      const parsed = normalizeAttendant(
        JSON.parse(await readFile(join(paths.runDir, name), "utf8")),
      );
      if (parsed) records.push(parsed);
    } catch {
      /* advisory data gone bad; skip */
    }
  }
  return records;
};

/** Every sidecar still holding identity the log does not know yet. The
 *  normalizer guarantees a pending record carries the full identity, so a
 *  caller can promote without re-proving fields. */
export const readPendingAttendants = async (paths: SessionPaths): Promise<Attendant[]> =>
  (await readSidecars(paths)).filter((a) => a.pendingBinding === true);

/**
 * The most recent attendant across all `cursor.<harness>.json` sidecars in the
 * session dir. Several harnesses may have attended over the session's life;
 * "who to resume" means the newest.
 */
export const readLastAttendant = async (paths: SessionPaths): Promise<Attendant | undefined> => {
  let latest: Attendant | undefined;
  for (const record of await readSidecars(paths)) {
    if (!latest || record.at > latest.at) latest = record;
  }
  return latest;
};

/**
 * The harness conversation an artifact belongs to, from the best source it
 * has. Two sources, because an artifact can carry either:
 *
 * 1. the LOG's session history - stamped by an agent that exported its
 *    identity (D18), and exact;
 * 2. the cursor sidecar an agent writes when it takes delivery, which names
 *    the harness and carries the resume command with the session id inside it.
 *
 * ONE resolver, used by the attend engine to know what to resume and by the
 * viewer to know whose presence to look for. They must never disagree: when
 * they did, the hub resumed a session the panel did not believe existed, and
 * the panel offered a resume command for a conversation already open.
 */
export const artifactAttendant = async (
  paths: SessionPaths,
  sessionHistory: readonly {
    readonly harness: string;
    readonly sessionId?: string;
    readonly cwd?: string;
  }[],
): Promise<
  | {
      readonly harness: string;
      readonly sessionId?: string;
      readonly cwd?: string;
      readonly resume?: string;
    }
  | undefined
> => {
  const stamped = [...sessionHistory].reverse().find((r) => r.sessionId !== undefined);
  if (stamped?.sessionId) {
    return {
      harness: stamped.harness,
      sessionId: stamped.sessionId,
      ...(stamped.cwd ? { cwd: stamped.cwd } : {}),
    };
  }
  const sidecar = await readLastAttendant(paths);
  if (!sidecar?.harness) {
    // No stamp with an id, no sidecar: the harness alone is still worth
    // reporting (the panel names it), even with nothing to resume.
    const named = [...sessionHistory].reverse().find((r) => r.harness)?.harness;
    return named ? { harness: named } : undefined;
  }
  return {
    harness: sidecar.harness,
    ...(sidecar.resume ? { resume: sidecar.resume } : {}),
  };
};
