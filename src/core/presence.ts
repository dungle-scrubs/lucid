import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { harnessKind } from "./harness.ts";
import { harnessSessionId } from "./harness-store.ts";

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
export const harnessSupportsPresence = (harness: string): boolean =>
  harnessKind(harness) === "claude";

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

/**
 * Whether this machine PUBLISHES presence at all. An empty `livePresence` map
 * means two very different things - "nothing is running" and "there is no
 * sessions directory to read" - and a caller about to treat ABSENCE as
 * evidence (the orphan sweep) must only do so where presence would actually
 * show. A missing or unreadable store proves nothing about any process.
 */
export const presenceStoreReadable = async (dir?: string): Promise<boolean> => {
  try {
    await readdir(claudeSessionsDir(dir));
    return true;
  } catch {
    return false;
  }
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
