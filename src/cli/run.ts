import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAttendantSidecar } from "../core/attendant.ts";
import { renderCursor } from "../core/cursor.ts";
import { deliver } from "../core/deliver.ts";
import { foldLog } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import { sessionPaths } from "../core/paths.ts";
import type { WaitPayload } from "../core/payload.ts";
import { ensureSessionDirs, openSession } from "../core/session.ts";
import { listSessions } from "../core/sessions.ts";
import { runWait, type WaitOptions } from "../core/wait.ts";
import { ArtifactError, NotFoundError, ServerError } from "../errors.ts";
import { ingestPayload } from "../plan/ingest.ts";
import { renderPlanDoc } from "../plan/render.ts";
import { discoverLiveServer, removeServerDescriptor } from "../server/discovery.ts";
import { PORT_POOL, runServer } from "../server/server.ts";
import { openBrowser, spawnServer, waitForServer } from "./self.ts";

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const randomId = (): string => crypto.randomUUID();

export interface OpenOptions {
  readonly open?: boolean;
}

/** `lucid open <file>` - start/resume/re-segment a session and serve the viewer. */
export const runOpen = async (file: string, options: OpenOptions = {}): Promise<void> => {
  const paths = sessionPaths(file);
  const result = await openSession(paths);

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

/** `lucid ask <file> --text "..." [--ref <id>]` - pose a question to the human. */
export const runAsk = async (file: string, text: string, ref?: string): Promise<void> => {
  const paths = sessionPaths(file);
  const state = foldLog((await readEvents(paths.logPath)).events);
  if (state.status === "none") {
    throw new NotFoundError({
      message: `No Lucid session for ${paths.artifactPath}`,
      detail: { path: paths.artifactPath },
    });
  }
  const id = randomId();
  await deliver(paths, { t: "question", id, text, ...(ref ? { ref } : {}) });
  print({ session: paths.artifactPath, asked: id, text });
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
