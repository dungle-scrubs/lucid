import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mergeAttendantSidecar } from "../core/attendant.ts";
import { parseCursor, renderCursor } from "../core/cursor.ts";
import { deliver, promotePendingBindings } from "../core/deliver.ts";
import { sessionState } from "../core/log.ts";
import { ARTIFACT_DIR, canonicalArtifactPath, sessionPaths } from "../core/paths.ts";
import { enclosingCheckout } from "../core/project.ts";
import { isVolatilePath, scratchpadProject } from "../core/scratchpad.ts";
import { themeReadiness, themeWarning } from "../core/theme.ts";
import { registerSession } from "../core/registry.ts";
import { sanitizeBlocked, sanitizeProgress } from "../core/progress.ts";
import { sanitizeContext, writeContextSidecar } from "../core/context.ts";
import {
  assertCanonicalLocation,
  assertNoStrandedRecord,
  ensureSessionDirs,
  openSession,
} from "../core/session.ts";
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
import { runLaunch } from "../launch/fork-launcher.ts";
import { loadRegistry, registryPath } from "../launch/recipes.ts";
import { ingestPayload, parseWaitPayloadInput } from "../plan/ingest.ts";
import { planArtifactPath, renderPlanDoc, renderedSourceOf } from "../plan/render.ts";
import { HUB_PORT, hubInfo, hubOpen, parseHubPort, runDaemon } from "../server/daemon.ts";
import { sinkStatus } from "../server/observe.ts";
import { discoverLiveServer, loopbackFetch, removeServerDescriptor } from "../server/discovery.ts";
import { PORT_POOL, runServer } from "../server/server.ts";
import { decodeGroupText } from "./ask-input.ts";
import { resolveView, selectOpenUrl } from "../server/view.ts";
import {
  openBrowser,
  openChromeApp,
  spawnHub,
  ensureServer,
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
/** The turn this process IS, when the hub spawned it (plan 08, D-013).
 *  Exported as LUCID_TURN_ID exactly as LUCID_REQUEST_ID is, so the acks this
 *  turn writes carry the id the hub will name when it appends the terminator.
 *  Absent for an interactive turn nobody spawned - then the acks belong to the
 *  anonymous turn, which is how every pre-turnId log folds. */
const turnStamp = (): { turnId?: string } => {
  const t = process.env.LUCID_TURN_ID;
  return t && t.length > 0 ? { turnId: t.slice(0, 128) } : {};
};

const attendantStamp = (
  harness?: string,
  live?: { readonly model?: string; readonly effort?: string },
): AttendantStamp | undefined => {
  const h = harness || process.env.LUCID_HARNESS;
  const sessionId = process.env.LUCID_SESSION_ID;
  if (!h && !sessionId) return undefined;
  // Model/effort ride the same way (LUCID_MODEL / LUCID_EFFORT): the viewer's
  // inherited pickers show what the attending session actually runs. A caller
  // that STATES them (a wait declaring its current settings) outranks the
  // environment, which was read once when the session started.
  const model = live?.model ?? process.env.LUCID_MODEL;
  const effort = live?.effort ?? process.env.LUCID_EFFORT;
  // Through the shared normalizer even though we authored it: the direct-
  // append path bypasses the server, and the log's invariants (bounded,
  // control-free strings) must not depend on which writer was live.
  return sanitizeAttendant({
    harness: h || "agent",
    ...(sessionId ? { sessionId } : {}),
    cwd: process.cwd(),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // The click's trace (plan 07, M1.3): a spawned turn holds it in
    // LUCID_REQUEST_ID, and the sanitizer drops anything not well-formed.
    ...(process.env.LUCID_REQUEST_ID ? { trace: process.env.LUCID_REQUEST_ID } : {}),
    // Who vouches for the session id, and which launch this turn IS (plan 03):
    // both ride every stamp so a discovered create's progress can correlate
    // by launch before any native id exists, and a resume can rank the id's
    // authority. The sanitizer enforces the closed set / well-formed rule.
    ...(process.env.LUCID_SESSION_ID_AUTHORITY
      ? { sessionIdAuthority: process.env.LUCID_SESSION_ID_AUTHORITY }
      : {}),
    ...(process.env.LUCID_LAUNCH_ID ? { launchId: process.env.LUCID_LAUNCH_ID } : {}),
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
        `Write it somewhere durable, e.g. ${join(project, ARTIFACT_DIR, basename(file))}, and open that.`,
      detail: { path: resolve(file), suggested: join(project, ARTIFACT_DIR, basename(file)) },
    });
  }
  // Artifacts live at `<project>/.lucid/<name>.html` (plan 05, M3.2). Refused
  // before the identity guard: a misplaced artifact has to move regardless, so
  // naming the place to move it to is more use than a report about the record
  // it would have had here.
  assertCanonicalLocation(file);
  // Identity is the artifact's REAL path (plan 05, M1.1): a symlink and its
  // target are one session. Refuse first if unifying them would strand a
  // second history (R3).
  assertNoStrandedRecord(file);
  const paths = sessionPaths(file);
  const opener = attendantStamp();
  const result = await openSession(paths, opener ? { attendant: opener } : undefined);
  // Identity discovered before this open (a spawned harness announcing its
  // native session while authoring) has been waiting in the sidecar as a
  // pending binding; the log exists now, so the durable record lands
  // immediately after session_opened.
  await promotePendingBindings(paths);

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

  // Serialized across processes: two agents opening one artifact at the same
  // instant used to both spawn, leaving two servers appending to one log and
  // two callers disagreeing about the URL (plan 08, finding #16).
  if (!identity) identity = await ensureServer(paths);
  if (!identity) {
    throw new ServerError({
      message: "per-session server failed to start",
      detail: { path: paths.artifactPath },
    });
  }

  // ONE override point (plan 06, D-014). The two `viaHub.shell` assignments
  // above are deliberately untouched, which is what makes the default path
  // unchanged by construction rather than by assertion - and editing the URL
  // builder alone would have missed them, since `??=` never fires once the hub
  // answered, and the hub-hosted case is exactly what this targets.
  const view = resolveView(process.env);
  url = selectOpenUrl({ view, hubShell: url, identity });
  // The solo view must not REACH openBrowser - not merely suppress it.
  // `recordOpen` writes a `skipped` entry when LUCID_NO_OPEN suppresses a
  // launch, so "no browser entry" is satisfiable by a mechanism this path does
  // not use, and the scenario asserting an empty open-log needs the call to be
  // absent rather than quiet (D-012).
  const wantsBrowser = view !== "solo" && options.open !== false && !surfacedInShell;
  if (wantsBrowser) openBrowser(url);

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
    // The view is invisible unless stated, and a silent wrong URL is the
    // failure this exists to remove: an agent, a log, or a human reading the
    // payload can see WHY they got the URL they got.
    view,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
};

export interface WaitCliOptions extends WaitOptions {
  readonly reply?: string;
  readonly harness?: string;
  /** Ready-to-paste command that resumes this harness conversation. Recorded
   *  in the sidecar and surfaced (viewer, listing); never executed by Lucid. */
  readonly resume?: string;
  /**
   * What the attending session is running RIGHT NOW.
   *
   * The environment is read once, when the session starts; a human who changes
   * model or thinking level mid-conversation leaves Lucid displaying what the
   * session began with, and a harness that exports neither shows no model at
   * all. Every wait is a fresh process and a fresh chance to say - so a
   * harness that knows its current settings states them here, and the viewer
   * stops presenting a start-of-session capture as current state.
   */
  readonly model?: string;
  readonly effort?: string;
}

/** `lucid wait <file> [--since] [--timeout] [--reply] [--harness] [--resume]` - block
 *  for feedback. `--timeout 0` is a DRAIN: one read of the log, whatever is
 *  pending, no blocking (plan 06, D-016). */
export const runWaitCli = async (file: string, options: WaitCliOptions = {}): Promise<void> => {
  const paths = sessionPaths(file);

  if (options.reply !== undefined && options.reply.length > 0) {
    const attendant = attendantStamp(options.harness, {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
    });
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
      const attendant = attendantStamp(options.harness, {
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
      });
      // What this hand-off actually covers (D20): the cursor just read, not
      // the ack's own position. Feedback that lands between the read and this
      // append belongs to the NEXT batch, and the hub's attend engine reads
      // this claim to know a batch is already someone's.
      const covers = parseCursor(payload.nextCursor);
      await deliver(paths, {
        t: "agent_ack",
        id: randomId(),
        ...turnStamp(),
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
    const stamp = attendantStamp(harness, {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
    });
    // The FLAGS win over the environment: they are this turn's answer to
    // "what are you running", where the env is whatever was exported once.
    const model = options.model ?? stamp?.model;
    const effort = options.effort ?? stamp?.effort;
    // The attending session's OWN id, recorded as evidence rather than left
    // as a log mention: a mention never ranks (that is how a synthetic id once
    // reached resume argv), so a session that only ever stamped events would
    // otherwise become unresumable. `declared` is the honest authority - the
    // session asserted it through its environment; Lucid neither assigned nor
    // observed it.
    const declaredId = stamp?.sessionId;
    await mergeAttendantSidecar(paths, {
      harness,
      nextCursor: payload.nextCursor,
      at: new Date().toISOString(),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(declaredId ? { sessionId: declaredId, sessionIdAuthority: "declared" } : {}),
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
    ...turnStamp(),
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
/**
 * `lucid blocked <file> --reason "<one line>"` - the turn cannot continue
 * without the human.
 *
 * A headless turn has no terminal anyone is reading: a permission prompt it
 * cannot answer, a credential it does not have, an instruction it cannot act
 * on - each of those ends with the agent stopping and saying so into a void,
 * while the viewer shows a spinner over work that will never resume. This puts
 * the sentence where the human is actually looking. It does not end the turn:
 * answer the block and the agent's next ack clears it.
 */
export const runBlocked = async (file: string, reason: string): Promise<void> => {
  const paths = sessionPaths(file);
  // Validated here as well as server-side, for the same reason `progress` is:
  // the no-daemon path appends straight to the log without passing the ack
  // handler.
  const cleaned = sanitizeBlocked(reason);
  if (!cleaned) {
    throw new ValidationError({ message: "blocked needs a --reason", detail: { file } });
  }
  const attendant = attendantStamp();
  await deliver(paths, {
    t: "agent_ack",
    id: randomId(),
    ...turnStamp(),
    blocked: cleaned,
    ...(attendant ? { attendant } : {}),
  });
  print({ ok: true, blocked: cleaned });
};

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
    ...turnStamp(),
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
        // The trace is stamped by `loopbackFetch` (plan 08, finding #15).
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
 * Read `--group`'s JSON: a file path, or "-" for stdin. Only the reading is
 * here - what counts as an acceptable payload is `decodeGroupText`'s, so an
 * empty pipe and an unreadable file are the same refusal from one place.
 */
const readGroupSource = async (source: string): Promise<unknown> => {
  const raw =
    source === "-"
      ? await Bun.stdin.text()
      : await readFile(resolve(source), "utf8").catch(() => "");
  return decodeGroupText(raw, source);
};

export const runAsk = async (
  file: string,
  text: string | undefined,
  opts: { ref?: string; options?: readonly string[]; multi?: boolean; group?: string } = {},
): Promise<void> => {
  const paths = sessionPaths(file);
  const state = await sessionState(paths);
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
  const state = await sessionState(paths);
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
  const state = await sessionState(paths);
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
  const sessions = (await listSessions(process.cwd(), resolveView(process.env))).map((summary) => ({
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
    // Where the program's own evidence goes, and whether it is landing (M3.2).
    // "Is anything being recorded, and where" was answerable only by reading
    // the source - and a logger that fails silently is the one failure mode
    // that hides itself, because the file just stays small and looks idle.
    //
    // A LIVE hub is asked rather than re-derived: it may have been started
    // from a shell with a different LUCID_HUB_LOG, or with an explicitly
    // injected path this process cannot see, and reporting a file the writer
    // is not writing to is the same lie in a new spelling.
    log:
      (await hubInfo(parseHubPort(process.env.LUCID_HUB_PORT) ?? HUB_PORT).catch(() => undefined))
        ?.log ?? sinkStatus(),
    usage: {
      open: "lucid open <file>",
      wait: "lucid wait <file> [--since <cursor>] [--timeout <seconds>: 0 drains] [--reply <msg>] [--harness <id>] [--resume <cmd>]",
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
  /** Overwrite an artifact rendered from a DIFFERENT doc. */
  readonly force?: boolean;
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
  // Realpath'd, like every other identity surface (plan 05, M1.1): a symlink
  // and its target are one document, not two artifacts with two sessions. And
  // project-RELATIVE where there is a project, because the stamp is written
  // into a file meant to be committed and read on another machine, where an
  // absolute /Users/<someone>/ path compares equal to nothing.
  const abs = canonicalArtifactPath(doc);
  const sourceRoot = enclosingCheckout(dirname(abs));
  const source = sourceRoot === null ? abs : relative(sourceRoot, abs);
  const html = renderPlanDoc(markdown, {
    source,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.stage !== undefined ? { stage: options.stage } : {}),
  });
  const outPath = planArtifactPath(doc, options.out);
  // The artifact folder may not exist yet - this is often a project's FIRST
  // render, and `writeFile` answered that with a bare ENOENT.
  await mkdir(dirname(outPath), { recursive: true });
  // The artifact folder is flat, so two docs can want one path. `flatName` is
  // built to be injective and swept for it - but this refusal does not depend
  // on that being true, which is the point: a silent overwrite here also
  // silently attaches the next `open` to the FIRST doc's review history (the
  // basename is unchanged, so the stem-collision guard passes). Loud beats
  // provably-correct-this-time. Re-rendering the SAME doc still overwrites,
  // which is what an idempotent render means.
  const existing = await readFile(outPath, "utf8").catch(() => null);
  const owner = existing === null ? null : renderedSourceOf(existing);
  if (existing !== null && owner !== source && options.force !== true) {
    throw new ValidationError({
      message:
        `refusing to overwrite ${outPath} - it was rendered from ${owner ?? "a document this render cannot identify"}, not from ${source}. ` +
        `Two docs deriving one artifact would share one review history, and annotations would carry onto the other document's content. ` +
        `Pass --out to write elsewhere, or --force to replace it.`,
      detail: { artifact: outPath, renderedFrom: owner, rendering: source },
    });
  }
  await writeFile(outPath, html);
  print({ artifact: outPath, next: `lucid open ${outPath}` });
};

/** `lucid plan ingest --plan <name>` - map a wait payload (stdin) to plan-db. */
export const runPlanIngest = async (plan: string, payloadPath?: string): Promise<void> => {
  const raw = payloadPath ? await readFile(payloadPath, "utf8") : await Bun.stdin.text();
  print(ingestPayload(parseWaitPayloadInput(raw), plan));
};
