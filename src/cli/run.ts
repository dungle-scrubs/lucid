import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeAttendantSidecar } from "../core/attendant.ts";
import { parseCursor, renderCursor } from "../core/cursor.ts";
import { deliver } from "../core/deliver.ts";
import { foldLog } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import { sessionPaths } from "../core/paths.ts";
import { isVolatilePath, scratchpadProject } from "../core/scratchpad.ts";
import { themeReadiness, themeWarning } from "../core/theme.ts";
import type { WaitPayload } from "../core/payload.ts";
import { registerSession } from "../core/registry.ts";
import { sanitizeProgress } from "../core/progress.ts";
import { sanitizeContext, writeContextSidecar } from "../core/context.ts";
import { ensureSessionDirs, openSession } from "../core/session.ts";
import { listSessions } from "../core/sessions.ts";
import { runWait, type WaitOptions } from "../core/wait.ts";
import { sanitizeAttendant } from "../core/events.ts";
import type { AttendantStamp } from "../core/events.ts";
import {
  legacyProjection,
  normalizeQuestionGroup,
  validateGroup,
} from "../core/question-contract.ts";
import { ArtifactError, NotFoundError, ServerError, ValidationError } from "../errors.ts";
import { runLaunch } from "../launch/launcher.ts";
import { loadRegistry, registryPath } from "../launch/recipes.ts";
import { ingestPayload } from "../plan/ingest.ts";
import { renderPlanDoc } from "../plan/render.ts";
import { HUB_PORT, hubInfo, hubOpen, parseHubPort, runDaemon } from "../server/daemon.ts";
import {
  discoverLiveServer,
  loopbackFetch,
  removeServerDescriptor,
  viewerUrl,
} from "../server/discovery.ts";
import { PORT_POOL, runServer } from "../server/server.ts";
import {
  openBrowser,
  openChromeApp,
  spawnHub,
  spawnServer,
  stopServer,
  waitForServer,
} from "./self.ts";

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const randomId = (): string => crypto.randomUUID();

/**
 * D18 provenance from the invoking harness's environment. A harness (or its
 * lucid skill) exports LUCID_HARNESS and LUCID_SESSION_ID once; every event
 * this CLI writes then carries who produced it, and the fold derives the
 * artifact's session history from the stamps. No env, no stamp - old
 * integrations keep working unlabeled. `--harness` on `wait` doubles as the
 * harness identity when the env is absent. cwd rides along because resuming
 * a harness session is cwd-scoped.
 */
const attendantStamp = (harness?: string): AttendantStamp | undefined => {
  const h = harness || process.env.LUCID_HARNESS;
  const sessionId = process.env.LUCID_SESSION_ID;
  if (!h && !sessionId) return undefined;
  // Model/effort ride the same way (LUCID_MODEL / LUCID_EFFORT): the viewer's
  // inherited pickers show what the attending session actually runs.
  const model = process.env.LUCID_MODEL;
  const effort = process.env.LUCID_EFFORT;
  // Through the shared normalizer even though we authored it: the direct-
  // append path bypasses the server, and the log's invariants (bounded,
  // control-free strings) must not depend on which writer was live.
  return sanitizeAttendant({
    harness: h || "agent",
    ...(sessionId ? { sessionId } : {}),
    cwd: process.cwd(),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  });
};

export interface OpenOptions {
  readonly open?: boolean;
  /** Stop a live daemon first, so the next spawn loads a freshly built binary.
   *  Without it `open` reuses whatever server is already running (D-036). */
  readonly restart?: boolean;
}

/** `lucid open <file>` - start/resume/re-segment a session and serve the viewer. */
export const runOpen = async (file: string, options: OpenOptions = {}): Promise<void> => {
  // An artifact in a temp tree takes its ENTIRE review with it when the OS
  // clears that tree - and macOS clears /private/tmp on every boot, so a
  // month of annotated plans can vanish on a restart. A session's log,
  // versions and annotations live beside the artifact (`<dir>/.lucid/<stem>/`),
  // so this is not just a lost file: it is the whole conversation.
  //
  // Refused rather than warned. An agent authors here by default (the harness
  // hands it a scratchpad for temp files), reads no warnings, and the loss
  // surfaces weeks later with nothing to recover from.
  if (isVolatilePath(file)) {
    const project = (await scratchpadProject(dirname(resolve(file)))) ?? "<your project>";
    throw new ValidationError({
      message:
        `refusing to open an artifact in a temporary directory - the OS clears it (macOS wipes /private/tmp on every boot), ` +
        `and a session's annotations and versions live beside its artifact, so they would go too. ` +
        `Write it somewhere durable, e.g. ${join(project, "lucid", basename(file))}, and open that.`,
      detail: { path: resolve(file), suggested: join(project, "lucid", basename(file)) },
    });
  }
  const paths = sessionPaths(file);
  const opener = attendantStamp();
  const result = await openSession(paths, opener ? { attendant: opener } : undefined);

  // A running daemon embeds the client bundle it loaded at start; `open` alone
  // reattaches to it, so a rebuild is invisible until the process is replaced.
  // --restart stops the live one first without touching the session (no
  // session_ended), so the spawn below starts fresh on the current binary.
  // (A hub-hosted session is left alone: its descriptor names the shared
  // daemon, and stopServer refuses to kill that.)
  if (options.restart) await stopServer(paths);

  let identity = await discoverLiveServer(paths);
  let url: string | undefined;
  // A connected shell window already surfaced this session as a tab: the
  // /hub/open broadcast told it to. Popping the default browser NEXT TO that
  // window is worse than doing nothing, so the launch below is skipped.
  let surfacedInShell = false;

  // Model B: a running hub daemon is preferred - the session surfaces as a
  // TAB in the one shell window instead of spawning another process on
  // another port. No hub, or a session already served by a dedicated
  // server, keeps the exact pre-daemon behavior.
  if (!identity) {
    const viaHub = await hubOpen(paths.artifactPath);
    if (viaHub) {
      url = viaHub.shell;
      surfacedInShell = (viaHub.shells ?? 0) > 0;
      // The hub accepted this session - it owns it now. A transient miss on
      // the follow-up handshake must NOT fall through to spawning a
      // dedicated server: the hub's mount stays alive, and two appenders is
      // the split-brain the coexistence rule exists to prevent. Retry the
      // discovery instead, and fail loudly if the hub truly died mid-open.
      identity = await waitForServer(paths, 4000);
      if (!identity) {
        throw new ServerError({
          message: "the hub accepted the session but its mount never answered",
          detail: { path: paths.artifactPath, shell: viaHub.shell },
        });
      }
    }
  } else if (identity.base) {
    // Already hub-hosted (a repeat `open`): re-announce so live windows raise
    // the tab again - same idempotent route, no remount side effects.
    const viaHub = await hubOpen(paths.artifactPath);
    if (viaHub) {
      url = viaHub.shell;
      surfacedInShell = (viaHub.shells ?? 0) > 0;
    }
  }

  if (!identity) {
    await removeServerDescriptor(paths); // clear any stale descriptor
    spawnServer(paths);
    identity = await waitForServer(paths, 8000);
  }
  if (!identity) {
    throw new ServerError({
      message: "per-session server failed to start",
      detail: { path: paths.artifactPath },
    });
  }

  url ??= viewerUrl(identity);
  if (options.open !== false && !surfacedInShell) openBrowser(url);

  // Register a pointer in the global hub registry (Model B, Phase 0). Advisory:
  // a registry failure must never fail `open`.
  try {
    await registerSession(paths.artifactPath);
  } catch {
    /* registry is a discovery convenience, not part of the open contract */
  }

  // Said at author time, where it can still be acted on: the viewer's
  // light/dark choice only reaches an artifact whose colors run through the
  // standard tokens, and the alternative is a human at midnight wondering why
  // one document stayed bright. Advisory - fixed colors are sometimes correct.
  const theme = await readFile(paths.artifactPath, "utf8")
    .then((html) => themeWarning(themeReadiness(html)))
    .catch(() => undefined);
  const warnings = [
    ...result.warnings,
    ...(theme ? [{ code: "THEME_NOT_ADAPTIVE", message: theme }] : []),
  ];

  print({
    session: paths.artifactPath,
    version: result.state.version,
    status: "active",
    nextCursor: renderCursor(result.cursor),
    url,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
};

export interface WaitCliOptions extends WaitOptions {
  readonly reply?: string;
  readonly harness?: string;
  /** Ready-to-paste command that resumes this harness conversation. Recorded
   *  in the sidecar and surfaced (viewer, listing); never executed by Lucid. */
  readonly resume?: string;
}

/** `lucid wait <file> [--since] [--reply] [--harness] [--resume]` - block for feedback. */
export const runWaitCli = async (file: string, options: WaitCliOptions = {}): Promise<void> => {
  const paths = sessionPaths(file);

  if (options.reply !== undefined && options.reply.length > 0) {
    const attendant = attendantStamp(options.harness);
    await deliver(paths, {
      t: "agent_reply",
      id: randomId(),
      text: options.reply,
      ...(attendant ? { attendant } : {}),
    });
  }

  const payload = await runWait(paths, options);

  // Ack on delivery (cursor path only): the viewer flips to "agent is
  // working". Best-effort - a failed ack must never fail the wait itself -
  // and never on a no-cursor bootstrap fold, which is a catch-up read, not a
  // hand-off (D-064).
  if (payload.status === "feedback" && options.since !== undefined) {
    try {
      const attendant = attendantStamp(options.harness);
      // What this hand-off actually covers (D20): the cursor just read, not
      // the ack's own position. Feedback that lands between the read and this
      // append belongs to the NEXT batch, and the hub's attend engine reads
      // this claim to know a batch is already someone's.
      const covers = parseCursor(payload.nextCursor);
      await deliver(paths, {
        t: "agent_ack",
        id: randomId(),
        ...(covers !== undefined ? { covers } : {}),
        ...(attendant ? { attendant } : {}),
      });
    } catch {
      /* presence is advisory */
    }
  }

  // `--resume` without `--harness` still records identity, under a generic name.
  const harness = options.harness || (options.resume ? "agent" : undefined);
  if (harness !== undefined) {
    // The sidecar carries the same env-declared model/effort as the stamps,
    // through the same normalizer, so the viewer's inherited pickers and the
    // log agree on what the attending session runs.
    // The RESOLVED harness, not the flag: `--resume` alone still names an
    // attendant, and its declared model/effort must reach the sidecar too.
    const stamp = attendantStamp(harness);
    await writeAttendantSidecar(paths, {
      harness,
      nextCursor: payload.nextCursor,
      at: new Date().toISOString(),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(stamp?.model ? { model: stamp.model } : {}),
      ...(stamp?.effort ? { effort: stamp.effort } : {}),
    });
  }

  print(payload);
};

/**
 * `lucid intent <file> <revise|reply>` - refine an open working window with
 * declared intent, so the viewer can say "an update is on the way" vs "a
 * reply is coming". A promise, not a fact: the window still only closes on
 * real output. Best-effort, like the ack it refines.
 */
export const runIntent = async (file: string, intent: "revise" | "reply"): Promise<void> => {
  const paths = sessionPaths(file);
  const attendant = attendantStamp();
  await deliver(paths, {
    t: "agent_ack",
    id: randomId(),
    intent,
    ...(attendant ? { attendant } : {}),
  });
  print({ ok: true, intent });
};

/**
 * `lucid progress <file> [--label <text>] [--total <n>] [--done <n>]` - refine
 * the open working window with self-reported fan-out status, so the viewer can
 * show "N agents in progress · done/total reported" instead of a lone spinner.
 * Call at fan-out start with `--total`, then re-call to bump `--done` as tasks
 * report. Advisory like `intent`: the window still only closes on real output.
 */
export const runProgress = async (
  file: string,
  progress: { label?: string; total?: number; done?: number },
): Promise<void> => {
  const paths = sessionPaths(file);
  // Validate here, not just server-side: `deliver` falls back to a direct log
  // append when no daemon answers, which never passes through the ack handler.
  const cleaned = sanitizeProgress(progress);
  if (!cleaned) {
    // Thrown, not printed. This used to `print({ok:false})` and return, which
    // exits 0 - so `if lucid progress …; then` read a refusal as success and
    // every agent checking the exit code before parsing saw nothing wrong.
    throw new ValidationError({
      message: "progress needs a --label, --total, or --done",
      detail: { file },
    });
  }
  const attendant = attendantStamp();
  await deliver(paths, {
    t: "agent_ack",
    id: randomId(),
    progress: cleaned,
    ...(attendant ? { attendant } : {}),
  });
  print({ ok: true, progress: cleaned });
};

/**
 * `lucid context <file> [--pct <n>] [--used <n>] [--total <m>]` - report the
 * attending harness's context-window usage, drawn from its statusline (the only
 * place the real figure exists; the model cannot read its own). Renders as the
 * header ring. POSTs to the live server so it broadcasts, or writes the sidecar
 * directly when no daemon answers - the same live-or-direct rule as `deliver`,
 * but for a last-value sidecar rather than a log event.
 */
export const runContext = async (
  file: string,
  usage: { pct?: number; used?: number; total?: number },
): Promise<void> => {
  const paths = sessionPaths(file);
  const clean = sanitizeContext(usage);
  if (!clean) {
    throw new ValidationError({
      message: "context needs a --pct, or --used with --total",
      detail: { file },
    });
  }
  const live = await discoverLiveServer(paths);
  if (live) {
    try {
      const res = await loopbackFetch(live.port, `${live.base ?? ""}/__lucid/context`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(usage),
      });
      // A stale daemon (older build, no /__lucid/context) 404s, and one that
      // dies mid-request throws - either way fall through to the direct write
      // rather than report a success that never landed.
      if (res.ok) {
        print({ ok: true, live: true, context: clean });
        return;
      }
    } catch {
      /* server vanished between handshake and post - use the sidecar */
    }
  }
  await writeContextSidecar(paths, { ...clean, at: new Date().toISOString() });
  print({ ok: true, live: false, context: clean });
};

/** `lucid ask <file> --text "..." [--ref <id>]` - pose a question to the human. */
/** Parse a `--option "Label|explanation"` string into a structured choice. */
const parseOption = (raw: string): { label: string; description?: string } | undefined => {
  const sep = raw.indexOf("|");
  const label = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  if (label.length === 0) return undefined;
  const description = sep === -1 ? "" : raw.slice(sep + 1).trim();
  return { label, ...(description.length > 0 ? { description } : {}) };
};

/**
 * The most a question group's JSON may be before it is parsed. The normalizer
 * bounds every FIELD, but only after `JSON.parse` has already materialized
 * whatever a file or a pipe handed in; five questions of twelve choices fit in
 * a fraction of this, so anything past it is not a group.
 */
const MAX_GROUP_CHARS = 512 * 1024;

/** Read `--group`'s JSON: a file path, or "-" for stdin. */
const readGroupSource = async (source: string): Promise<unknown> => {
  const raw =
    source === "-"
      ? await Bun.stdin.text()
      : await readFile(resolve(source), "utf8").catch(() => "");
  if (raw.trim() === "") {
    throw new ValidationError({
      message:
        source === "-" ? "no question group on stdin" : `cannot read question group: ${source}`,
      detail: { source },
    });
  }
  if (raw.length > MAX_GROUP_CHARS) {
    throw new ValidationError({
      message: `question group is too large (max ${MAX_GROUP_CHARS} characters)`,
      detail: { source },
    });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ValidationError({
      message: `question group is not valid JSON: ${(e as Error).message}`,
      detail: { source },
    });
  }
};

export const runAsk = async (
  file: string,
  text: string | undefined,
  opts: { ref?: string; options?: readonly string[]; multi?: boolean; group?: string } = {},
): Promise<void> => {
  const paths = sessionPaths(file);
  const state = foldLog((await readEvents(paths.logPath)).events);
  if (state.status === "none") {
    throw new NotFoundError({
      message: `No Lucid session for ${paths.artifactPath}`,
      detail: { path: paths.artifactPath },
    });
  }
  const id = randomId();
  const attendant = attendantStamp();
  // The rich grouped form (D12). Normalized and validated through the SAME
  // module the server accepts with, so a group this command takes is a group
  // the drawer can render and the server would re-accept.
  if (opts.group !== undefined) {
    // The two ways to ask are exclusive. Accepting both and quietly preferring
    // the group would drop flags the caller believed they had sent.
    if (text !== undefined || (opts.options ?? []).length > 0 || opts.multi === true) {
      throw new ValidationError({
        message: "lucid ask takes --group or --text/--option/--multi, not both",
        detail: { path: paths.artifactPath },
      });
    }
    const group = normalizeQuestionGroup(await readGroupSource(opts.group));
    const issues = validateGroup(group);
    if (issues.length > 0) {
      throw new ValidationError({
        message: `invalid question group: ${issues.map((i) => i.message).join(" ")}`,
        detail: { issues },
      });
    }
    const legacy = legacyProjection(group);
    await deliver(paths, {
      t: "question",
      id,
      text: legacy.text,
      ...(opts.ref ? { ref: opts.ref } : {}),
      ...(legacy.options ? { options: legacy.options } : {}),
      ...(legacy.multi ? { multi: true } : {}),
      group,
      ...(attendant ? { attendant } : {}),
    });
    print({
      session: paths.artifactPath,
      asked: id,
      text: legacy.text,
      questions: group.map((q) => ({ id: q.id, question: q.question, shape: q.answerShape })),
    });
    return;
  }
  if (text === undefined || text.trim() === "") {
    throw new ValidationError({
      message: "lucid ask needs --text <question> or --group <file|->",
      detail: { path: paths.artifactPath },
    });
  }
  const options = (opts.options ?? []).map(parseOption).filter((o) => o !== undefined);
  await deliver(paths, {
    t: "question",
    id,
    text,
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(opts.multi && options.length > 0 ? { multi: true } : {}),
    ...(attendant ? { attendant } : {}),
  });
  print({
    session: paths.artifactPath,
    asked: id,
    text,
    ...(options.length > 0 ? { options } : {}),
  });
};

/** `lucid end <file>` - terminal end of the session. */
export const runEnd = async (file: string): Promise<void> => {
  const paths = sessionPaths(file);
  const state = foldLog((await readEvents(paths.logPath)).events);
  if (state.status === "none") {
    throw new NotFoundError({
      message: `No Lucid session for ${paths.artifactPath}`,
      detail: { path: paths.artifactPath },
    });
  }
  if (state.status === "ended") {
    print({ session: paths.artifactPath, status: "ended" });
    return;
  }
  const { live } = await deliver(paths, { t: "session_ended" });
  // A live server removes its own descriptor as it stops; a dead one left it behind.
  if (!live) await removeServerDescriptor(paths);
  print({ session: paths.artifactPath, status: "ended" });
};

export interface LaunchCliOptions {
  readonly pollMs?: number;
}

/**
 * `lucid launch <file>` - the opt-in fork launcher. Watches the session for
 * fork requests and spawns a headless agent per fork via the harness registry,
 * then attends each child (shape C). Foreground; Ctrl-C stops it.
 */
export const runLaunchCli = async (file: string, options: LaunchCliOptions = {}): Promise<void> => {
  const paths = sessionPaths(file);
  const state = foldLog((await readEvents(paths.logPath)).events);
  if (state.status === "none") {
    throw new NotFoundError({
      message: `No Lucid session for ${paths.artifactPath}`,
      detail: { path: paths.artifactPath },
    });
  }
  const registry = await loadRegistry();
  if (!registry) {
    throw new ValidationError({
      message: `no harness registry at ${registryPath()} - create it to enable the fork launcher`,
      detail: {
        path: registryPath(),
        example: {
          default: "claude_code",
          harnesses: {
            claude_code: {
              spawn: [
                "claude",
                "-p",
                "--session-id",
                "{id}",
                "--allowedTools",
                "Bash(lucid *) Write Edit Read",
                "{prompt}",
              ],
              resume: [
                "claude",
                "--resume",
                "{id}",
                "-p",
                "--allowedTools",
                "Bash(lucid *) Write Edit Read",
                "{prompt}",
              ],
            },
          },
        },
      },
    });
  }
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    await runLaunch(paths, registry, {
      signal: controller.signal,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
};

/** `lucid __serve <file>` - the long-lived per-session daemon body (hidden). */
export const runServe = async (file: string): Promise<void> => {
  const paths = sessionPaths(file);
  ensureSessionDirs(paths);
  const idleMs = process.env.LUCID_IDLE_MS
    ? Number.parseInt(process.env.LUCID_IDLE_MS, 10)
    : undefined;
  await runServer(paths, PORT_POOL, idleMs !== undefined ? { idleMs } : {});
};

/**
 * `lucid hub [--port <n>] [--attend]` - the always-on hub daemon (Model B).
 * Starts the shared loopback server in the foreground and logs its URL, then
 * blocks until Ctrl-C. Hosts every session in-process under `/s/<id>` and
 * serves the shell at `/`; sessions with a live dedicated server are proxied,
 * never double-hosted. `LUCID_HUB_PORT` overrides the default (tests).
 *
 * `--attend` (or `LUCID_HUB_ATTEND=1`) opts this hub into the delivery engine
 * (D15/D19): it drives a headless turn for feedback nobody is listening for,
 * and answers `POST /hub/create`. Without it the hub spawns nothing.
 */
export const runHub = async (options: { port?: number; attend?: boolean } = {}): Promise<void> => {
  // options.port is CLI-validated (Options.integer); only the env needs the
  // strict parse. `--port 0` stays allowed for tests (ephemeral bind).
  const port = options.port ?? parseHubPort(process.env.LUCID_HUB_PORT);
  // Comma-separated scan roots override (tests, or a machine whose projects
  // do not live under ~/dev).
  const roots = process.env.LUCID_HUB_ROOTS?.split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  // Env opt-in for supervised starts (launchd/systemd), where there is no
  // command line to edit. Explicit "1" only: a stray non-empty value must not
  // silently turn a review-only install into one that spawns agents.
  const attend = options.attend === true || process.env.LUCID_HUB_ATTEND === "1";
  const daemon = await runDaemon({
    ...(port !== undefined ? { port } : {}),
    ...(roots && roots.length > 0 ? { roots } : {}),
    ...(attend ? { attend } : {}),
  });
  process.stdout.write(
    `lucid hub listening on http://127.0.0.1:${daemon.port}${attend ? " (attend mode: headless turns enabled)" : ""}\n`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      void daemon.stop().then(resolve);
    });
    process.once("SIGTERM", () => {
      void daemon.stop().then(resolve);
    });
  });
};

/**
 * `lucid app` - the human's front door to the shell (Model B, Phase 4).
 * Ensures the hub daemon is up (spawns it detached if not), then opens the
 * ONE stable entry URL as a Chrome app window - a Dock icon that never goes
 * stale on a rotating session port. Falls back to the default browser when
 * no Chrome flavor is installed.
 */
export const runApp = async (): Promise<void> => {
  const envPort = parseHubPort(process.env.LUCID_HUB_PORT);
  const port = envPort ?? HUB_PORT;

  let info = await hubInfo(port);
  if (!info) {
    // The app front door drives delivery itself; a review-only hub would
    // record feedback and wait for a human to go re-summon a conversation.
    spawnHub(envPort, true);
    const deadline = Date.now() + 8000;
    while (!info && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      info = await hubInfo(port);
    }
  }
  if (!info) {
    throw new ServerError({ message: "hub daemon failed to start", detail: { port } });
  }

  // A connected shell window IS the app - opening another would stack
  // windows on every invocation. The window updates itself (the listing
  // stream carries the hub's bundle stamp), so there is nothing to do.
  // A surviving window needs a beat to reconnect before it shows up in
  // `shells` - and that is true WHETHER OR NOT the hub was alive at the
  // first probe (a just-spawned hub after a restart is the common case
  // that used to stack a window every time). Always give the beat.
  if (info.shells === 0) {
    const deadline = Date.now() + 2500;
    while (info && info.shells === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      info = await hubInfo(port);
    }
  }

  const url = `http://127.0.0.1:${port}/`;
  if (info && info.shells > 0) {
    print({ hub: url, app: "already-open", shells: info.shells, status: "running" });
    return;
  }
  const asApp = openChromeApp(url);
  if (!asApp) openBrowser(url);
  print({ hub: url, app: asApp, status: "running" });
};

/** `lucid` (bare) - status over per-session server.json discovery (no global registry; D-065). */
export const runStatus = async (): Promise<void> => {
  const sessions = (await listSessions(process.cwd())).map((summary) => ({
    session: summary.session,
    status: summary.status,
    version: summary.version,
    segment: summary.segment,
    annotations: summary.annotations,
    live: summary.live,
    ...(summary.viewer ? { viewer: summary.viewer } : {}),
    ...(summary.resume ? { resume: summary.resume } : {}),
    ...(summary.lastAttendant ? { lastAttendant: summary.lastAttendant } : {}),
  }));
  print({
    sessions,
    usage: {
      open: "lucid open <file>",
      wait: "lucid wait <file> [--since <cursor>] [--reply <msg>] [--harness <id>] [--resume <cmd>]",
      ask: 'lucid ask <file> --text "<q>" [--option "label|desc"]... [--multi] [--ref <id>]',
      progress: "lucid progress <file> [--label <text>] [--total <n>] [--done <n>]",
      context: "lucid context <file> [--pct <n>] [--used <n>] [--total <m>]",
      end: "lucid end <file>",
      hub: "lucid hub [--attend]",
    },
  });
};

export interface PlanRenderOptions {
  readonly out?: string;
  readonly title?: string;
  readonly stage?: string;
}

/** `lucid plan render <doc.md>` - render a planner doc to a Lucid artifact. */
export const runPlanRender = async (
  doc: string,
  options: PlanRenderOptions = {},
): Promise<void> => {
  let markdown: string;
  try {
    markdown = await readFile(doc, "utf8");
  } catch (err) {
    throw new ArtifactError({
      message: `cannot read plan doc: ${(err as Error).message}`,
      detail: { path: doc },
    });
  }
  const html = renderPlanDoc(markdown, {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.stage !== undefined ? { stage: options.stage } : {}),
  });
  const outPath = resolve(options.out ?? `${doc.replace(/\.md$/i, "")}.lucid.html`);
  await writeFile(outPath, html);
  print({ artifact: outPath, next: `lucid open ${outPath}` });
};

/** `lucid plan ingest --plan <name>` - map a wait payload (stdin) to plan-db. */
export const runPlanIngest = async (plan: string, payloadPath?: string): Promise<void> => {
  const raw = payloadPath ? await readFile(payloadPath, "utf8") : await Bun.stdin.text();
  let payload: WaitPayload;
  try {
    payload = JSON.parse(raw) as WaitPayload;
  } catch {
    throw new ArtifactError({ message: "could not parse wait payload JSON from input" });
  }
  print(ingestPayload(payload, plan));
};
