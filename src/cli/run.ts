import { Glob } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderCursor } from "../core/cursor.ts";
import { foldLog } from "../core/fold.ts";
import { appendEvent, readEvents } from "../core/log.ts";
import { cursorSidecarPath, sessionPaths } from "../core/paths.ts";
import type { WaitPayload } from "../core/payload.ts";
import { ensureSessionDirs, openSession } from "../core/session.ts";
import { runWait, type WaitOptions } from "../core/wait.ts";
import { ArtifactError, NotFoundError, ServerError } from "../errors.ts";
import { ingestPayload } from "../plan/ingest.ts";
import { renderPlanDoc } from "../plan/render.ts";
import {
  discoverLiveServer,
  readServerDescriptor,
  removeServerDescriptor,
} from "../server/discovery.ts";
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
}

/** `lucid wait <file> [--since] [--reply] [--harness]` - block for feedback. */
export const runWaitCli = async (file: string, options: WaitCliOptions = {}): Promise<void> => {
  const paths = sessionPaths(file);

  if (options.reply !== undefined && options.reply.length > 0) {
    const live = await discoverLiveServer(paths);
    const id = randomId();
    if (live) {
      await fetch(`http://127.0.0.1:${live.port}/__lucid/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${live.port}` },
        body: JSON.stringify({ id, text: options.reply }),
      });
    } else {
      // No live server: direct write under the exclusive log lock (D-049).
      await appendEvent(paths.logPath, { t: "agent_reply", id, text: options.reply });
    }
  }

  const payload = await runWait(paths, options);

  if (options.harness !== undefined && options.harness.length > 0) {
    await writeFile(
      cursorSidecarPath(paths, options.harness),
      `${JSON.stringify({ harness: options.harness, nextCursor: payload.nextCursor, at: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  print(payload);
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
  const live = await discoverLiveServer(paths);
  if (live) {
    await fetch(`http://127.0.0.1:${live.port}/__lucid/question`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${live.port}` },
      body: JSON.stringify({ id, text, ...(ref ? { ref } : {}) }),
    });
  } else {
    await appendEvent(paths.logPath, { t: "question", id, text, ...(ref ? { ref } : {}) });
  }
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
  const live = await discoverLiveServer(paths);
  if (live) {
    await fetch(`http://127.0.0.1:${live.port}/__lucid/end`, {
      method: "POST",
      headers: { host: `127.0.0.1:${live.port}` },
    });
  } else {
    await appendEvent(paths.logPath, { t: "session_ended" });
    await removeServerDescriptor(paths);
  }
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
  const cwd = process.cwd();
  const glob = new Glob("**/.lucid/*/server.json");
  const sessions: unknown[] = [];
  for await (const rel of glob.scan({ cwd, dot: true, onlyFiles: true })) {
    // rel like  .lucid/<name>/server.json  or  sub/dir/.lucid/<name>/server.json
    const parts = rel.split("/");
    const idx = parts.lastIndexOf(".lucid");
    if (idx === -1 || parts[idx + 1] === undefined) continue;
    const name = parts[idx + 1];
    const artifactDir = parts.slice(0, idx).join("/") || ".";
    // Reconstruct an approximate artifact path; the descriptor holds the canonical one.
    const fakePath = `${cwd}/${artifactDir}/${name}.html`.replace("//", "/");
    const paths = sessionPaths(fakePath);
    const descriptor = await readServerDescriptor(paths);
    if (!descriptor) continue;
    const realPaths = sessionPaths(descriptor.session);
    const identity = await discoverLiveServer(realPaths);
    sessions.push({
      session: descriptor.session,
      port: descriptor.port,
      live: identity !== undefined,
      version: identity?.version,
      viewer: identity ? `http://127.0.0.1:${descriptor.port}/__lucid/viewer` : undefined,
    });
  }
  print({
    sessions,
    usage: {
      open: "lucid open <file>",
      wait: "lucid wait <file> [--since <cursor>] [--reply <msg>] [--harness <id>]",
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
