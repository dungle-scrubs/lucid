import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isUsableSessionId } from "../launch/session-identity.ts";
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
 * The pids whose argv shows a HEADLESS invocation - `-p` / `--print`.
 *
 * `presenceFor` exists to tell the panel "a human is watching this in a
 * terminal, do not drive turns". The hub's OWN attend engine resumes a session
 * headlessly (`claude --resume <id> -p …`), and a resumed conversation keeps
 * its original `kind` in the session file - so an attend turn on a session that
 * WAS interactive re-registers as `kind: interactive` and gets misread as a
 * person. The `kind` field cannot be trusted through a `-p` resume; the argv
 * can, because print mode is exactly what "no human at a REPL" looks like.
 *
 * The token is matched with word boundaries so a `-p` sitting inside the
 * prompt text (which `ps` joins into the same line) is not mistaken for the
 * flag - and a false miss only ever SUPPRESSES an interactive claim, the safe
 * direction: the panel falls back to spawn/listening, never up to a human that
 * is not there.
 */
export const headlessPidsIn = (psOutput: string): Set<number> => {
  const headless = new Set<number>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    if (/(?:^|\s)(?:-p|--print)(?:\s|$)/.test(m[2])) headless.add(Number.parseInt(m[1], 10));
  }
  return headless;
};

/**
 * Ask the OS for the FULL command line behind each pid.
 *
 * `command`, not `comm`: `comm` is the executed file's name alone (`claude`),
 * and `headlessPidsIn` needs to see the `-p` flag to tell an attend turn from a
 * human's REPL - which lives in the argv, not the name. Liveness
 * (`harnessPidsIn`) still just tests for "claude" anywhere on the line, so it is
 * unaffected by the wider column.
 *
 * Injectable, and the reason is not tidiness. Proving that this check rejects a
 * recycled pid needs a live process whose command names "claude", and a test
 * can only produce one by executing a file called `claude-something`. The
 * fixture tried that by copying `/bin/sleep`, and a copied platform binary
 * fails macOS code signature validation: the process is SIGKILLed, and enough
 * repetitions crash `syspolicyd` outright and take new app launches down with
 * it. Twice, on this project, before anyone connected the two.
 *
 * So the pid stays real - a plain `sleep`, genuinely running, genuinely
 * reaped - and only the STRING the OS would report is substituted. What the
 * check does with that string is `harnessPidsIn`/`headlessPidsIn`, both pure
 * and tested directly.
 *
 * Substituting it is not a licence to leave the real thing untested: everything
 * that can be wrong with `ps` - the flags, the pid list, the exit handling -
 * lives in `realPs` and is invisible to a stubbed test, because every failure
 * mode degrades to an empty set and reads as "nothing is live". So `realPs` is
 * exported and exercised directly against processes this suite spawns itself.
 */
export type ProcessLister = (pids: readonly number[]) => Promise<string>;

export const realPs: ProcessLister = async (pids) => {
  const proc = Bun.spawn(["ps", "-p", pids.join(","), "-o", "pid=,command="], {
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

/** Put the real `ps` back unconditionally. A test that installs a stub and then
 *  throws never reaches its own undo, and `bun test` shares one process across
 *  files - so a leaked stub turns presence detection off for everything that
 *  runs afterwards, silently and with nothing naming the cause. */
export const resetProcessLister = (): void => {
  listProcesses = realPs;
};

const sweepHarnessPids = async (
  pids: readonly number[],
): Promise<{ live: Set<number>; headless: Set<number> }> => {
  if (pids.length === 0) return { live: new Set(), headless: new Set() };
  try {
    const out = await listProcesses(pids);
    return { live: harnessPidsIn(out), headless: headlessPidsIn(out) };
  } catch {
    // No `ps` (or it refused): report nothing rather than guessing a session
    // is live. Every caller's fallback is the pre-detection behaviour.
    return { live: new Set(), headless: new Set() };
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

  const { live, headless } = await sweepHarnessPids(candidates.map((c) => c.pid as number));
  const byId = new Map<string, HarnessPresence>();
  for (const c of candidates) {
    const pid = c.pid as number;
    const sessionId = c.sessionId as string;
    if (!live.has(pid)) continue;
    const presence: HarnessPresence = {
      sessionId,
      pid,
      // A `-p` process is the hub's own headless attend turn, never a human at
      // a terminal - so it is not interactive whatever `kind` the resumed
      // session file inherited (see headlessPidsIn). The panel must not tell a
      // reviewer "someone is watching this" about the hub's own worker.
      interactive: c.kind === "interactive" && !headless.has(pid),
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
  const kind = harness.trim().toLowerCase().replace(/_/g, "-");
  const anchored =
    kind === "claude-code" || kind === "claude"
      ? new RegExp(String.raw`--resume\s+(${UUID.source})(?:\s|$)`, "i").exec(command)
      : kind === "codex"
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

/** True when a rollout file naming this thread id exists in the local Codex
 *  store: `<store>/YYYY/MM/DD/rollout-<stamp>-<threadId>.jsonl`. A bounded
 *  three-level walk over date directories; any read failure is "not here". */
const codexStoreHas = async (sessionId: string, dir?: string): Promise<boolean> => {
  const root = codexSessionsDir(dir);
  const needle = `-${sessionId}.jsonl`;
  try {
    for (const year of await readdir(root)) {
      const yearDir = join(root, year);
      for (const month of await readdir(yearDir).catch(() => [])) {
        const monthDir = join(yearDir, month);
        for (const day of await readdir(monthDir).catch(() => [])) {
          const names = await readdir(join(monthDir, day)).catch(() => []);
          if (names.some((name) => name.endsWith(needle))) return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
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
  opts: { readonly claudeProjectsDir?: string; readonly codexSessionsDir?: string } = {},
): Promise<boolean> => {
  // The id becomes a PATH SEGMENT below (`<store>/<dir>/<id>.jsonl`), and it
  // reaches here from a log event, a sidecar file, or a harness's stdout -
  // none of them ours. An id shaped like `../../../etc/passwd` would stat its
  // way out of the store and answer "corroborated" for a file that has
  // nothing to do with any harness.
  if (!isUsableSessionId(sessionId)) return false;
  const kind = harness.trim().toLowerCase().replace(/_/g, "-");
  if (kind === "claude-code" || kind === "claude") {
    return (
      (await findSessionCwd(claudeProjectsDir(opts.claudeProjectsDir), sessionId)) !== undefined
    );
  }
  if (kind === "codex") return codexStoreHas(sessionId, opts.codexSessionsDir);
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
