import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  readonly nextCursor: string;
  readonly at: string;
  /** Ready-to-paste command that resumes the harness conversation. */
  readonly resume?: string;
  /** Model the attending session runs on (from its environment), display data
   *  for the viewer's inherited pickers. */
  readonly model?: string;
  /** Effort/reasoning level the attending session runs at, same provenance. */
  readonly effort?: string;
}

export const writeAttendantSidecar = async (
  paths: SessionPaths,
  attendant: Attendant,
): Promise<void> => {
  const target = cursorSidecarPath(paths, attendant.harness);
  await mkdir(dirname(target), { recursive: true }); // sidecars live in run/ (plan 02)
  await writeFile(target, `${JSON.stringify(attendant, null, 2)}\n`);
};

const isAttendant = (v: unknown): v is Attendant =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Attendant).harness === "string" &&
  typeof (v as Attendant).at === "string";

/**
 * The most recent attendant across all `cursor.<harness>.json` sidecars in the
 * session dir. Several harnesses may have attended over the session's life;
 * "who to resume" means the newest.
 */
export const readLastAttendant = async (paths: SessionPaths): Promise<Attendant | undefined> => {
  // The cursor sidecars are machine-scoped, so they live in run/ (plan 02).
  let names: string[];
  try {
    names = await readdir(paths.runDir);
  } catch {
    return undefined;
  }
  let latest: Attendant | undefined;
  for (const name of names) {
    if (!/^cursor\..+\.json$/.test(name)) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(paths.runDir, name), "utf8"));
      if (isAttendant(parsed) && (!latest || parsed.at > latest.at)) latest = parsed;
    } catch {
      /* an unreadable sidecar is advisory data gone bad; skip it */
    }
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
