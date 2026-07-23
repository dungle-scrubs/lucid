import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAttendantSidecar } from "../core/attendant.ts";
import { renderCursor } from "../core/cursor.ts";
import { deliver } from "../core/deliver.ts";
import { foldLog } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import { sessionPaths } from "../core/paths.ts";
import type { WaitPayload } from "../core/payload.ts";
import { sanitizeProgress } from "../core/progress.ts";
import { sanitizeContext, writeContextSidecar } from "../core/context.ts";
import { ensureSessionDirs, openSession } from "../core/session.ts";
import { listSessions } from "../core/sessions.ts";
import { runWait, type WaitOptions } from "../core/wait.ts";
import { ArtifactError, NotFoundError, ServerError, ValidationError } from "../errors.ts";
import { runLaunch } from "../launch/launcher.ts";
import { loadRegistry, registryPath } from "../launch/recipes.ts";
import { ingestPayload } from "../plan/ingest.ts";
import { renderPlanDoc } from "../plan/render.ts";
import { discoverLiveServer, loopbackFetch, removeServerDescriptor } from "../server/discovery.ts";
import { PORT_POOL, runServer } from "../server/server.ts";
import { openBrowser, spawnServer, stopServer, waitForServer } from "./self.ts";

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const randomId = (): string => crypto.randomUUID();

export interface OpenOptions {
  readonly open?: boolean;
  /** Stop a live daemon first, so the next spawn loads a freshly built binary.
   *  Without it `open` reuses whatever server is already running (D-036). */
  readonly restart?: boolean;
}

/** `lucid open <file>` - start/resume/re-segment a session and serve the viewer. */
export const runOpen = async (file: string, options: OpenOptions = {}): Promise<void> => {
  const paths = sessionPaths(file);
  const result = await openSession(paths);

  // A running daemon embeds the client bundle it loaded at start; `open` alone
  // reattaches to it, so a rebuild is invisible until the process is replaced.
  // --restart stops the live one first without touching the session (no
  // session_ended), so the spawn below starts fresh on the current binary.
  if (options.restart) await stopServer(paths);

  let identity = await discoverLiveServer(paths);
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

  const url = `http://127.0.0.1:${identity.port}/__lucid/viewer`;
  if (options.open !== false) openBrowser(url);

  print({
    session: paths.artifactPath,
    version: result.state.version,
    status: "active",
    nextCursor: renderCursor(result.cursor),
    url,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
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
    await deliver(paths, { t: "agent_reply", id: randomId(), text: options.reply });
  }

  const payload = await runWait(paths, options);

  // Ack on delivery (cursor path only): the viewer flips to "agent is
  // working". Best-effort - a failed ack must never fail the wait itself -
  // and never on a no-cursor bootstrap fold, which is a catch-up read, not a
  // hand-off (D-064).
  if (payload.status === "feedback" && options.since !== undefined) {
    try {
      await deliver(paths, { t: "agent_ack", id: randomId() });
    } catch {
      /* presence is advisory */
    }
  }

  // `--resume` without `--harness` still records identity, under a generic name.
  const harness = options.harness || (options.resume ? "agent" : undefined);
  if (harness !== undefined) {
    await writeAttendantSidecar(paths, {
      harness,
      nextCursor: payload.nextCursor,
      at: new Date().toISOString(),
      ...(options.resume ? { resume: options.resume } : {}),
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
  await deliver(paths, { t: "agent_ack", id: randomId(), intent });
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
    print({ ok: false, error: "progress needs a --label, --total, or --done" });
    return;
  }
  await deliver(paths, { t: "agent_ack", id: randomId(), progress: cleaned });
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
    print({ ok: false, error: "context needs a --pct, or --used with --total" });
    return;
  }
  const live = await discoverLiveServer(paths);
  if (live) {
    try {
      const res = await loopbackFetch(live.port, "/__lucid/context", {
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

export const runAsk = async (
  file: string,
  text: string,
  opts: { ref?: string; options?: readonly string[]; multi?: boolean } = {},
): Promise<void> => {
  const paths = sessionPaths(file);
  const state = foldLog((await readEvents(paths.logPath)).events);
  if (state.status === "none") {
    throw new NotFoundError({
      message: `No Lucid session for ${paths.artifactPath}`,
      detail: { path: paths.artifactPath },
    });
  }
  const options = (opts.options ?? []).map(parseOption).filter((o) => o !== undefined);
  const id = randomId();
  await deliver(paths, {
    t: "question",
    id,
    text,
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(opts.multi && options.length > 0 ? { multi: true } : {}),
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
