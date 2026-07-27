import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { decodeFlattenedPath } from "./scratchpad.ts";

/**
 * Is the harness conversation behind an artifact OPEN right now, in a terminal
 * somebody is sitting at?
 *
 * Lucid's own liveness signal only sees an agent BLOCKED in `lucid wait`. A
 * human with the conversation open, mid-thought, is invisible to it - so the
 * viewer told them "no agent connected, here is a command to resume" about a
 * session already running two windows away, and the hub would happily resume
 * that same conversation headlessly underneath them.
 *
 * Claude Code publishes what is needed: `~/.claude/sessions/<pid>.json`, one
 * per running process, carrying the session id, the cwd, `kind` (interactive
 * or not) and a live `idle`/`busy` status. A resumed conversation keeps its
 * session id, so a human who copies the resume command and runs it is detected
 * from that moment on - the mode follows the terminal, not the history.
 *
 * This is one harness's private layout, not a standard: unknown harnesses
 * report nothing and every caller falls back to what it did before.
 */

/** A harness conversation currently running on this machine. */
export interface HarnessPresence {
  readonly sessionId: string;
  readonly pid: number;
  /** Where that conversation is running, when the harness records it. */
  readonly cwd?: string;
  /** `interactive` = a terminal someone can type into. Anything else (a
   *  headless `-p` run, a spawned turn) is not a human at a keyboard. */
  readonly interactive: boolean;
  /** The harness's own live status, e.g. `idle` / `busy`. */
  readonly status?: string;
}

/** Harnesses whose live sessions Lucid can see. */
export const PRESENCE_HARNESSES = ["claude-code", "claude_code", "claude"] as const;

export const harnessSupportsPresence = (harness: string): boolean =>
  (PRESENCE_HARNESSES as readonly string[]).includes(harness.trim().toLowerCase());

/** Where Claude Code publishes its running sessions. Injectable for tests. */
export const claudeSessionsDir = (dir?: string): string => {
  if (dir) return dir;
  if (process.env.LUCID_CLAUDE_SESSIONS) return process.env.LUCID_CLAUDE_SESSIONS;
  return resolve(homedir(), ".claude", "sessions");
};

interface SessionFile {
  readonly pid?: number;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly kind?: string;
  readonly status?: string;
}

/**
 * Which of these pids are alive AND still the harness. One `ps` for the whole
 * set, not one per pid.
 *
 * The command-name check is what makes a stale file safe: a process killed
 * hard never removes its own file, and the pid is eventually handed to
 * something else - without this, that file would read as a live conversation
 * forever.
 */
export const harnessPidsIn = (psOutput: string): Set<number> => {
  const live = new Set<number>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    if (/claude/i.test(m[2])) live.add(Number.parseInt(m[1], 10));
  }
  return live;
};

/**
 * Ask the OS for the command name behind each pid.
 *
 * Injectable, and the reason is not tidiness. Proving that this check rejects a
 * recycled pid needs a live process whose `comm` contains "claude", and `comm`
 * on macOS comes from the name of the executed FILE - so a test can only
 * produce one by executing a file called `claude-something`. The fixture did
 * that by copying `/bin/sleep`, and a copied platform binary fails macOS code
 * signature validation: the process is SIGKILLed, and enough repetitions crash
 * `syspolicyd` outright and take new app launches down with it. Twice, on this
 * project, before anyone connected the two.
 *
 * So the pid stays real - a plain `sleep`, genuinely running, genuinely
 * reaped - and only the NAME the OS would report is substituted. What the check
 * does with that name is `harnessPidsIn`, which is pure and tested directly.
 */
export type ProcessLister = (pids: readonly number[]) => Promise<string>;

const realPs: ProcessLister = async (pids) => {
  const proc = Bun.spawn(["ps", "-p", pids.join(","), "-o", "pid=,comm="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
};

let listProcesses: ProcessLister = realPs;

/** Substitute the process listing. Returns the undo, so a test cannot leave it
 *  installed for whatever runs next. */
export const setProcessLister = (lister: ProcessLister): (() => void) => {
  const previous = listProcesses;
  listProcesses = lister;
  return () => {
    listProcesses = previous;
  };
};

const liveHarnessPids = async (pids: readonly number[]): Promise<Set<number>> => {
  if (pids.length === 0) return new Set();
  try {
    return harnessPidsIn(await listProcesses(pids));
  } catch {
    // No `ps` (or it refused): report nothing rather than guessing a session
    // is live. Every caller's fallback is the pre-detection behaviour.
    return new Set();
  }
};

/**
 * Every live harness conversation, indexed by session id. Sessions whose
 * process is gone are dropped, so what comes back is running NOW.
 */
export const livePresence = async (dir?: string): Promise<Map<string, HarnessPresence>> => {
  const root = claudeSessionsDir(dir);
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n.endsWith(".json"));
  } catch {
    return new Map(); // no such directory: this harness is not installed here
  }

  const candidates: SessionFile[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name), "utf8")) as SessionFile;
      if (typeof parsed?.sessionId === "string" && typeof parsed.pid === "number") {
        candidates.push(parsed);
      }
    } catch {
      /* unreadable or half-written: skip this one, never fail the sweep */
    }
  }

  const live = await liveHarnessPids(candidates.map((c) => c.pid as number));
  const byId = new Map<string, HarnessPresence>();
  for (const c of candidates) {
    const pid = c.pid as number;
    const sessionId = c.sessionId as string;
    if (!live.has(pid)) continue;
    const presence: HarnessPresence = {
      sessionId,
      pid,
      interactive: c.kind === "interactive",
      ...(c.cwd ? { cwd: c.cwd } : {}),
      ...(c.status ? { status: c.status } : {}),
    };
    // An interactive conversation outranks a headless one on the same id: the
    // human at the keyboard is who the viewer must not talk over.
    const existing = byId.get(sessionId);
    if (!existing || (presence.interactive && !existing.interactive)) byId.set(sessionId, presence);
  }
  return byId;
};

/**
 * The sweep costs a directory read plus one `ps`, and every state poll of
 * every open tab would otherwise pay it. A short TTL keeps "resumed in a
 * terminal just now" arriving within a beat while collapsing a burst of tabs
 * into one sweep.
 */
const CACHE_MS = 1500;
let cached: { at: number; dir: string; map: Map<string, HarnessPresence> } | undefined;

export const livePresenceCached = async (dir?: string): Promise<Map<string, HarnessPresence>> => {
  const root = claudeSessionsDir(dir);
  const now = Date.now();
  if (cached && cached.dir === root && now - cached.at < CACHE_MS) return cached.map;
  const map = await livePresence(root);
  cached = { at: now, dir: root, map };
  return map;
};

/** Drop the sweep cache (tests, and anything that must not read a stale one). */
export const resetPresenceCache = (): void => {
  cached = undefined;
};

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

const findSessionCwd = async (root: string, sessionId: string): Promise<string | undefined> => {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined; // this harness files nothing here
  }
  for (const name of names) {
    try {
      if (!(await stat(join(root, name, `${sessionId}.jsonl`))).isFile()) continue;
    } catch {
      continue; // not this one
    }
    return await decodeFlattenedPath(name);
  }
  return undefined;
};

/** A 36-char UUID, as every harness names its sessions. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
 * The live conversation for an attendant record, if there is one. The single
 * entry point callers should use: it answers `undefined` for an unsupported
 * harness, an unresolvable session id, or a conversation that is not running -
 * three different facts that all mean the same thing to a caller ("not open").
 */
export const presenceFor = async (
  attendant:
    | {
        readonly harness?: string;
        readonly sessionId?: string;
        readonly resume?: string;
      }
    | undefined,
  artifactDir?: string,
  dir?: string,
): Promise<HarnessPresence | undefined> => {
  if (!attendant?.harness || !harnessSupportsPresence(attendant.harness)) return undefined;
  const id = harnessSessionId({
    ...(attendant.sessionId ? { sessionId: attendant.sessionId } : {}),
    ...(attendant.resume ? { resume: attendant.resume } : {}),
    ...(artifactDir ? { artifactDir } : {}),
  });
  if (!id) return undefined;
  return (await livePresenceCached(dir)).get(id);
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
  const h = harness.trim().toLowerCase().replace(/_/g, "-");
  // Each harness's own flag name, verified against its --help. Settings default
  // this ON (see LucidSettings.resumeYolo): the command drops you back into a
  // conversation about your own artifact, and re-approving every tool call is
  // what it exists to spare you.
  const yolo = opts.yolo === true;
  if (h === "claude-code" || h === "claude") {
    return `claude --resume ${sessionId}${yolo ? " --dangerously-skip-permissions" : ""}`;
  }
  if (h === "codex") {
    return `codex resume ${sessionId}${yolo ? " --dangerously-bypass-approvals-and-sandbox" : ""}`;
  }
  return undefined;
};
