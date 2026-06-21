import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { join } from "node:path";
import { parseAnchor } from "../anchors/anchor.ts";
import { foldLog } from "../core/fold.ts";
import type { EventInput, LogEvent } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { ServerError } from "../errors.ts";
import { buildWaitPayload } from "../core/payload.ts";
import { commitWatchedChange } from "../core/session.ts";
import { CLIENT_BUNDLE } from "./client-bundle.generated.ts";
import { removeServerDescriptor, writeServerDescriptor } from "./discovery.ts";
import { injectOverlay } from "./inject.ts";
import { resolveAsset, validateHeaders } from "./security.ts";
import { renderViewer } from "./viewer.ts";

export interface ServerOptions {
  /** Idle window before auto-suspend (ms). 0 disables auto-suspend. */
  readonly idleMs?: number;
  /** Watcher debounce (ms). */
  readonly debounceMs?: number;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 150;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const noStore = { "cache-control": "no-store" } as const;

/**
 * Run the per-session loopback server (the long-lived daemon body). It is the
 * sole appender during the active session: browser POSTs and CLI control
 * writes route through `serverAppend`, which serializes via the log lock and
 * broadcasts to SSE subscribers. Resolves when the session is ended or
 * auto-suspended.
 */
/** Reserved per-session port pool (see ~/.agents/PORTS.md), then ephemeral. */
export const PORT_POOL: readonly number[] = [
  17412, 17413, 17414, 17415, 17416, 17417, 17418, 17419, 0,
];

export const runServer = async (
  paths: SessionPaths,
  requestedPorts: readonly number[],
  options: ServerOptions = {},
): Promise<void> => {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let port = 0; // assigned once the server binds (below)
  let stopped = false;
  let lastActivity = Date.now();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const touch = (): void => {
    lastActivity = Date.now();
  };

  const broadcast = (event: LogEvent): void => {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const client of sseClients) {
      try {
        client.enqueue(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const serverAppend = async (inputs: readonly EventInput[]): Promise<readonly LogEvent[]> => {
    const events = await appendEvents(paths.logPath, inputs);
    for (const e of events) broadcast(e);
    touch();
    return events;
  };

  const currentVersion = async (): Promise<number> => {
    const state = foldLog((await readEvents(paths.logPath)).events);
    return state.version;
  };

  // ---- request handling -----------------------------------------------------

  const handleEvents = (): Response => {
    let self: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        sseClients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        sseClients.delete(self);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  };

  const handleAnnotation = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.note !== "string") {
      return json({ error: "invalid annotation" }, 400);
    }
    const anchor = parseAnchor(body.target);
    if ("error" in anchor) return json({ error: anchor.error }, 400);
    const version =
      typeof body.version === "number" && Number.isInteger(body.version) ? body.version : 0;
    await serverAppend([
      { t: "annotation", id: body.id, version, target: anchor, note: body.note },
    ]);
    return json({ ok: true });
  };

  const handleMessage = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.text !== "string") {
      return json({ error: "invalid message" }, 400);
    }
    const refs = Array.isArray(body.refs)
      ? body.refs.filter((r): r is string => typeof r === "string")
      : [];
    await serverAppend([{ t: "prompt", id: body.id, refs, text: body.text }]);
    return json({ ok: true });
  };

  const handleReply = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.text !== "string") {
      return json({ error: "invalid reply" }, 400);
    }
    await serverAppend([{ t: "agent_reply", id: body.id, text: body.text }]);
    return json({ ok: true });
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (watcher) watcher.close();
    if (idleTimer) clearInterval(idleTimer);
    for (const client of sseClients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    sseClients.clear();
    await removeServerDescriptor(paths);
    boundServer.stop(true);
    resolveDone();
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

    const headerCheck = validateHeaders(req, port);
    if (!headerCheck.ok) {
      return json({ error: `forbidden: ${headerCheck.reason}` }, 403);
    }
    touch();

    // ---- control routes (reserved prefix) ----
    if (pathname === "/__lucid/identity") {
      return json({
        lucid: true,
        session: paths.artifactPath,
        port,
        version: await currentVersion(),
      });
    }
    if (pathname === "/__lucid/viewer") {
      return new Response(
        renderViewer({
          session: paths.artifactPath,
          name: basename(paths.artifactPath),
          port,
          version: await currentVersion(),
        }),
        { headers: { "content-type": "text/html; charset=utf-8", ...noStore } },
      );
    }
    if (pathname === "/__lucid/client.js") {
      return new Response(CLIENT_BUNDLE, {
        headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/events") {
      return handleEvents();
    }
    if (pathname === "/__lucid/artifact") {
      const html = await readFile(paths.currentHtml, "utf8").catch(() => "");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/state") {
      const state = foldLog((await readEvents(paths.logPath)).events);
      const currentHtml = await readFile(paths.currentHtml, "utf8").catch(() => "");
      const payload = await buildWaitPayload({
        session: paths.artifactPath,
        state,
        status:
          state.status === "ended"
            ? "ended"
            : state.status === "suspended"
              ? "suspended"
              : "feedback",
        currentHtml,
        snapshotAbsPath: (rel) => join(paths.sessionDir, rel),
        annotations: state.annotations,
        messages: state.messages,
        nextSeq: state.highSeq,
      });
      return json(payload);
    }
    if (pathname === "/__lucid/annotation" && req.method === "POST") return handleAnnotation(req);
    if (pathname === "/__lucid/message" && req.method === "POST") return handleMessage(req);
    if (pathname === "/__lucid/reply" && req.method === "POST") return handleReply(req);
    if (pathname === "/__lucid/resolve" && req.method === "POST") {
      await serverAppend([{ t: "review_resolved" }]);
      return json({ ok: true });
    }
    if (pathname === "/__lucid/reopen" && req.method === "POST") {
      await serverAppend([{ t: "review_reopened" }]);
      return json({ ok: true });
    }
    if (pathname === "/__lucid/end" && req.method === "POST") {
      await serverAppend([{ t: "session_ended" }]);
      queueMicrotask(() => void stop());
      return json({ ok: true });
    }

    // ---- artifact document route (fixed; D-054) ----
    if (pathname === "/") {
      const html = await readFile(paths.currentHtml, "utf8").catch(() => null);
      if (html === null) return json({ error: "artifact not available" }, 404);
      return new Response(injectOverlay(html), {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      });
    }

    // ---- static asset route ----
    const resolved = resolveAsset(pathname, paths.artifactDir);
    if (!resolved.ok) {
      broadcastWarning(resolved.warning.code, resolved.warning.message);
      return json({ error: resolved.warning.message }, resolved.status);
    }
    const file = Bun.file(resolved.absPath);
    if (!(await file.exists())) {
      broadcastWarning("ASSET_NOT_FOUND", `asset not found: ${pathname}`);
      return json({ error: "not found" }, 404);
    }
    return new Response(file, { headers: { "content-type": resolved.contentType } });
  };

  // Surface denied/missing assets to subscribers as a synthetic event so the
  // chrome can show them (D-054). Encoded as an agent-less warning frame.
  const broadcastWarning = (code: string, message: string): void => {
    const chunk = encoder.encode(`event: warning\ndata: ${JSON.stringify({ code, message })}\n\n`);
    for (const client of sseClients) {
      try {
        client.enqueue(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  let server: ReturnType<typeof Bun.serve> | undefined;
  let lastErr: unknown;
  for (const candidate of requestedPorts) {
    try {
      server = Bun.serve({
        port: candidate,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        async fetch(req) {
          try {
            return await handle(req);
          } catch (err) {
            return json({ error: `server error: ${(err as Error).message}` }, 500);
          }
        },
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!server) {
    throw new ServerError({
      message: `could not bind any port in [${requestedPorts.join(", ")}]: ${(lastErr as Error)?.message ?? "unknown"}`,
    });
  }
  const boundServer = server;
  port = boundServer.port ?? 0;

  await writeServerDescriptor(paths, {
    port,
    pid: process.pid,
    session: paths.artifactPath,
    startedAt: new Date().toISOString(),
  });

  // ---- file watcher ----------------------------------------------------------
  const artifactBase = basename(paths.artifactPath);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onChange = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void commitWatchedChange(paths)
        .then((result) => {
          if (result.committed) {
            broadcast({
              t: "version",
              seq: -1,
              at: new Date().toISOString(),
              version: result.committed.version,
              hash: result.committed.hash,
              path: result.committed.path,
            } as LogEvent);
          } else if (result.warning) {
            broadcastWarning(result.warning.code, result.warning.message);
          }
        })
        .catch(() => {});
    }, debounceMs);
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(paths.artifactDir, (_event, filename) => {
      if (filename === artifactBase) onChange();
    });
  } catch {
    watcher = undefined;
  }

  // ---- idle suspend ----------------------------------------------------------
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  if (idleMs > 0) {
    idleTimer = setInterval(
      () => {
        if (Date.now() - lastActivity > idleMs && !stopped) {
          void (async () => {
            await appendEvents(paths.logPath, [{ t: "session_suspended" }]);
            await stop();
          })();
        }
      },
      Math.min(idleMs, 5000),
    );
  }

  return done;
};
