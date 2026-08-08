import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { harnessKind } from "./harness.ts";
import { isUsableSessionId } from "./session-id.ts";
import { decodeFlattenedPath } from "./scratchpad.ts";

/**
 * Per-harness on-disk store adapters (M1.12), split out of `presence.ts`.
 *
 * Two questions lived in one module: "is a harness process RUNNING here" (the
 * `ps` sweep, which stays in `presence.ts`) and "does this machine's harness
 * STORE hold a recorded conversation" (these adapters). They share nothing but
 * the harness name: the sweep reads process tables, the store reads transcript
 * files, and `presenceFor` is the one bridge (it stays in `presence.ts` because
 * it needs both). Splitting the store out lets `attend.ts` reach it directly
 * once the attend gate (plan 05 Phase 4) lifts; until then `presence.ts`
 * re-exports this surface so every existing caller is untouched.
 *
 * Layering: this is a `core/` leaf. It imports harness identity (`harness.ts`),
 * the scratchpad path codec, and the session-id shape - nothing from `launch/`
 * or `server/`, and nothing back into `presence.ts`.
 */

/** Where Claude Code files conversation transcripts, one directory per cwd. */
export const claudeProjectsDir = (dir?: string): string => {
  if (dir) return dir;
  if (process.env.LUCID_CLAUDE_PROJECTS) return process.env.LUCID_CLAUDE_PROJECTS;
  return resolve(homedir(), ".claude", "projects");
};

/**
 * The directory a recorded session must be RESUMED from.
 *
 * `claude --resume <id>` only finds a conversation filed under the cwd it is
 * run in: transcripts live at `<projects>/<flattened-cwd>/<id>.jsonl`, so the
 * transcript's own location IS the answer, and it is the only source that
 * cannot be wrong.
 *
 * Everything else Lucid could guess from is a near miss that fails the same
 * way. An artifact in `<repo>/lucid/plan.html` says `<repo>/lucid`; the hub's
 * own cwd says wherever the daemon was started. Both resolved to a real
 * directory, and both produced "No conversation found with session ID" on
 * every turn - fifteen silent failures behind an "update on the way…" that
 * never cleared.
 */
const sessionCwdCache = new Map<string, string | undefined>();

/** Drop the memoized cwd lookups (tests, and anything that must not read a
 *  stale one). */
export const resetSessionCwdCache = (): void => sessionCwdCache.clear();

/**
 * Memoized: a conversation's cwd is fixed for its lifetime, and the lookup
 * walks every project directory the harness has ever recorded - hundreds of
 * stats, which an attend pass was paying on every single turn.
 */
export const harnessSessionCwd = async (
  sessionId: string,
  dir?: string,
): Promise<string | undefined> => {
  const root = claudeProjectsDir(dir);
  const key = `${root}\u0000${sessionId}`;
  const hit = sessionCwdCache.get(key);
  if (hit !== undefined || sessionCwdCache.has(key)) return hit;
  const answer = await findSessionCwd(root, sessionId);
  sessionCwdCache.set(key, answer);
  return answer;
};

/** The flattened directory whose transcript names this session, or undefined
 *  when this machine holds none. EXISTENCE only - decoding that directory to
 *  a real cwd is a separate question with a separate failure mode. */
const findSessionDir = async (root: string, sessionId: string): Promise<string | undefined> => {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined; // this harness files nothing here
  }
  for (const name of names) {
    try {
      if ((await stat(join(root, name, `${sessionId}.jsonl`))).isFile()) return name;
    } catch {
      // not this one
    }
  }
  return undefined;
};

const findSessionCwd = async (root: string, sessionId: string): Promise<string | undefined> => {
  const name = await findSessionDir(root, sessionId);
  return name === undefined ? undefined : decodeFlattenedPath(name);
};

/** Where Muse files its sessions (index at ~/.local/share/muse/session-index.db). */
export const museSessionsDir = (dir?: string): string => {
  if (dir) return dir;
  if (process.env.LUCID_MUSE_SESSIONS) return process.env.LUCID_MUSE_SESSIONS;
  // Default per Muse docs: ~/.local/share/muse/sessions/YYYY/MM/DD/{id}/session.jsonl
  // XDG_DATA_HOME fallback not needed on macOS; hardcode homedir variant.
  return join(homedir(), ".local", "share", "muse", "sessions");
};

/** A 36-char UUID, as every harness names its sessions. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_EVERYWHERE = new RegExp(UUID.source, "gi");

/**
 * Fixed per-harness extraction of the session id a RECORDED resume command
 * names (D-011). Replaces the first-UUID-wins scan for automatic resume: a
 * UUID sitting in a path argument or quoted prompt text was returned as the
 * session id with no error, and resuming it started a stranger.
 *
 * The rules are deliberately rigid: the id must sit exactly where the
 * harness's own CLI puts it, the command must contain no OTHER uuid (two ids
 * is ambiguity, and ambiguity is display-only), and a harness this module
 * has no parser for yields nothing - never a guess.
 */
export const parseHarnessResumeCommand = (harness: string, command: string): string | undefined => {
  const kind = harnessKind(harness);
  const anchored =
    kind === "claude"
      ? new RegExp(String.raw`--resume\s+(${UUID.source})(?:\s|$)`, "i").exec(command)
      : kind === "codex"
        ? new RegExp(String.raw`\bresume\s+(${UUID.source})(?:\s|$)`, "i").exec(command)
        : kind === "muse"
          ? new RegExp(String.raw`\bresume\s+(${UUID.source})(?:\s|$)`, "i").exec(command)
          : null;
  const id = anchored?.[1];
  if (!id) return undefined;
  const all = command.match(UUID_EVERYWHERE) ?? [];
  return all.length === 1 ? id : undefined;
};

/** Where Codex files its rollout transcripts (one per thread), overridable
 *  the same way the Claude stores are. */
export const codexSessionsDir = (dir?: string): string => {
  if (dir) return dir;
  if (process.env.LUCID_CODEX_SESSIONS) return process.env.LUCID_CODEX_SESSIONS;
  return join(homedir(), ".codex", "sessions");
};

/** The rollout file naming this thread id in the local Codex store
 *  (`<store>/YYYY/MM/DD/rollout-<stamp>-<threadId>.jsonl`), or undefined. A
 *  bounded three-level walk over date directories; any read failure is "not
 *  here". */
const codexRolloutPath = async (sessionId: string, dir?: string): Promise<string | undefined> => {
  const root = codexSessionsDir(dir);
  const needle = `-${sessionId}.jsonl`;
  try {
    for (const year of await readdir(root)) {
      const yearDir = join(root, year);
      for (const month of await readdir(yearDir).catch(() => [])) {
        const monthDir = join(yearDir, month);
        for (const day of await readdir(monthDir).catch(() => [])) {
          const names = await readdir(join(monthDir, day)).catch(() => []);
          const hit = names.find((name) => name.endsWith(needle));
          if (hit !== undefined) return join(monthDir, day, hit);
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const codexStoreHas = async (sessionId: string, dir?: string): Promise<boolean> =>
  (await codexRolloutPath(sessionId, dir)) !== undefined;

/** Muse session file (`<store>/YYYY/MM/DD/{id}/session.jsonl`). */
const museSessionPath = async (sessionId: string, dir?: string): Promise<string | undefined> => {
  const root = museSessionsDir(dir);
  try {
    for (const year of await readdir(root)) {
      const yearDir = join(root, year);
      for (const month of await readdir(yearDir).catch(() => [] as string[])) {
        const monthDir = join(yearDir, month);
        for (const day of await readdir(monthDir).catch(() => [] as string[])) {
          const dDir = join(monthDir, day);
          const entries = await readdir(dDir).catch(() => [] as string[]);
          if (entries.includes(sessionId)) {
            const candidate = join(dDir, sessionId, "session.jsonl");
            try {
              if ((await stat(candidate)).isFile()) return candidate;
            } catch {
              // not a file
            }
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const museStoreHas = async (sessionId: string, dir?: string): Promise<boolean> =>
  (await museSessionPath(sessionId, dir)) !== undefined;

/**
 * True when Lucid knows where this harness FILES its conversations on disk -
 * the precondition for asking `harnessStoreHas` a question whose "no" means
 * anything. An unknown harness corroborates nothing, and a pre-flight check
 * that read that as "the session is gone" would refuse every resume of a
 * harness Lucid simply has no store adapter for.
 */
export const harnessHasLocalStore = (harness: string): boolean => {
  const kind = harnessKind(harness);
  return kind === "claude" || kind === "codex" || kind === "muse";
};

/**
 * The transcript file the harness APPENDS while this session runs, or
 * undefined when the store has none (or the harness is unknown).
 *
 * This is the one liveness signal a buffered-stdout harness still gives:
 * `claude -p` writes stdout only when the turn ENDS, so a healthy
 * multi-minute turn shows zero bytes of output the whole way - but its
 * transcript at `<projects>/<flattened-cwd>/<id>.jsonl` grows on every API
 * event. A watchdog that measures only stdout reads that turn as wedged and
 * kills it mid-work, which is exactly what happened to live deliveries.
 */
export const harnessTranscriptPath = async (
  harness: string,
  sessionId: string,
  opts: {
    readonly claudeProjectsDir?: string;
    readonly codexSessionsDir?: string;
    readonly museSessionsDir?: string;
  } = {},
): Promise<string | undefined> => {
  if (!isUsableSessionId(sessionId)) return undefined;
  const kind = harnessKind(harness);
  if (kind === "claude") {
    const root = claudeProjectsDir(opts.claudeProjectsDir);
    const name = await findSessionDir(root, sessionId);
    return name === undefined ? undefined : join(root, name, `${sessionId}.jsonl`);
  }
  if (kind === "codex") return codexRolloutPath(sessionId, opts.codexSessionsDir);
  if (kind === "muse") return museSessionPath(sessionId, opts.museSessionsDir);
  return undefined;
};

/**
 * Current-machine corroboration (D-010): does THIS machine's harness store
 * hold the native session? A durable log binding can name an id minted on
 * another machine; resuming it here starts a stranger, so automatic resume
 * demands local evidence - a Claude transcript in the projects store, a Codex
 * rollout file - before a durable id may enter argv. A harness with no known
 * store corroborates nothing, which keeps its records display-only.
 */
export const harnessStoreHas = async (
  harness: string,
  sessionId: string,
  opts: {
    readonly claudeProjectsDir?: string;
    readonly codexSessionsDir?: string;
    readonly museSessionsDir?: string;
  } = {},
): Promise<boolean> => {
  // The id becomes a PATH SEGMENT below (`<store>/<dir>/<id>.jsonl`), and it
  // reaches here from a log event, a sidecar file, or a harness's stdout -
  // none of them ours. An id shaped like `../../../etc/passwd` would stat its
  // way out of the store and answer "corroborated" for a file that has
  // nothing to do with any harness.
  if (!isUsableSessionId(sessionId)) return false;
  const kind = harnessKind(harness);
  if (kind === "claude") {
    return (
      // Existence, NOT decodability: the question is whether this machine
      // holds the conversation, and a transcript filed under a directory whose
      // encoded path does not resolve here is still a transcript. Asking
      // findSessionCwd conflated the two and answered "not here" for every
      // session recorded under a path this machine does not have.
      (await findSessionDir(claudeProjectsDir(opts.claudeProjectsDir), sessionId)) !== undefined
    );
  }
  if (kind === "codex") return codexStoreHas(sessionId, opts.codexSessionsDir);
  if (kind === "muse") return museStoreHas(sessionId, opts.museSessionsDir);
  return false;
};

/**
 * The harness session id behind an artifact, from the best source available:
 *
 * 1. what the agent declared (`LUCID_SESSION_ID` at open time) - exact;
 * 2. the recorded resume command, which embeds it (`claude --resume <id>`) -
 *    exact, and present for sessions opened before Lucid asked for the stamp;
 * 3. the agent scratchpad the artifact sits in, whose path is named by it.
 *
 * Undefined when none of the three names one, which is the honest answer: no
 * id means no detection, and the caller keeps its old behaviour.
 */
export const harnessSessionId = (opts: {
  readonly sessionId?: string;
  readonly resume?: string;
  readonly artifactDir?: string;
}): string | undefined => {
  const declared = opts.sessionId?.trim();
  if (declared) return declared;
  const fromResume = opts.resume ? UUID.exec(opts.resume)?.[0] : undefined;
  if (fromResume) return fromResume;
  if (opts.artifactDir) {
    // `…/claude-<uid>/<encoded-cwd>/<session-uuid>/scratchpad[/…]`
    const parts = resolve(opts.artifactDir).split("/");
    const at = parts.lastIndexOf("scratchpad");
    const candidate = at > 0 ? parts[at - 1] : undefined;
    if (candidate && UUID.test(candidate)) return candidate;
  }
  return undefined;
};

/**
 * The command a HUMAN runs to open a recorded conversation interactively.
 *
 * Distinct from the registry's `resume` argv, which is the headless form
 * (`-p`) the hub drives turns with. A person wants the conversation in front of
 * them, so this omits `-p` - and it is synthesised from the session id alone,
 * which is why the panel can offer it for an artifact whose agent never wrote a
 * resume command down.
 */
export const interactiveResumeCommand = (
  harness: string,
  sessionId: string,
  opts: { readonly yolo?: boolean } = {},
): string | undefined => {
  const h = harnessKind(harness);
  // Each harness's own flag name, verified against its --help. Settings default
  // this ON (see LucidSettings.resumeYolo): the command drops you back into a
  // conversation about your own artifact, and re-approving every tool call is
  // what it exists to spare you.
  const yolo = opts.yolo === true;
  if (h === "claude") {
    return `claude --resume ${sessionId}${yolo ? " --dangerously-skip-permissions" : ""}`;
  }
  if (h === "codex") {
    return `codex resume ${sessionId}${yolo ? " --dangerously-bypass-approvals-and-sandbox" : ""}`;
  }
  if (h === "muse") {
    return `muse resume ${sessionId}${yolo ? " --yolo" : ""}`;
  }
  return undefined;
};
