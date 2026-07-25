import { defaultRoots, listAll, type RegistryEntry } from "../core/registry.ts";
import { validateHeaders } from "./security.ts";

/**
 * The always-on hub daemon (Model B, Phase 0). One long-lived loopback process
 * that reads the global pointer registry (src/core/registry.ts) and serves a
 * session listing + a stub shell UI. It stands up ALONGSIDE the existing
 * per-session servers; full migration is a later phase.
 *
 * It never spawns an agent and never appends to any log (D-064): the daemon only
 * reads the registry/logs and serves. Binds 127.0.0.1 only, behind the same
 * Host/Origin gate the per-session server uses (`validateHeaders`).
 */
export const HUB_PORT = 17428;

/** How often the SSE change-detector re-scans while subscribers are connected. */
const POLL_MS = 2000;

export interface DaemonOptions {
  /** Bind port. Default `HUB_PORT`; pass 0 to bind an ephemeral port. */
  readonly port?: number;
  /** Discovery roots for `listAll`. Default `~/dev`. */
  readonly roots?: readonly string[];
  /** Injected registry file path (tests). Default `<home>/.lucid/registry.json`. */
  readonly registryPath?: string;
}

export interface DaemonHandle {
  /** The actual bound port (resolved when an ephemeral port was requested). */
  readonly port: number;
  stop(): Promise<void>;
}

const noStore = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Minimal, self-contained placeholder page. The real shell UI is a later phase. */
const renderHubPage = (sessions: readonly RegistryEntry[]): string => {
  const rows =
    sessions.length === 0
      ? "<li><em>No sessions found.</em></li>"
      : sessions
          .map(
            (s) =>
              `<li><strong>${escapeHtml(s.name)}</strong> <code>${escapeHtml(s.artifact)}</code> <time>${escapeHtml(s.lastSeen)}</time></li>`,
          )
          .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lucid Hub</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.2rem; }
  p.stub { color: #888; }
  ul { list-style: none; padding: 0; }
  li { padding: 0.4rem 0; border-bottom: 1px solid #eee; }
  code { color: #555; }
  time { color: #999; font-size: 0.85em; }
</style>
</head>
<body>
<h1>Lucid Hub</h1>
<p class="stub">Placeholder page (Phase 0). The addressable shell UI ships in a later phase.</p>
<ul>
${rows}
</ul>
</body>
</html>
`;
};

/**
 * Start the hub daemon. Foreground callers keep the returned handle and await
 * their own shutdown; tests pass `port: 0` and call `stop()`.
 */
export const runDaemon = async (opts: DaemonOptions = {}): Promise<DaemonHandle> => {
  const roots = opts.roots ?? defaultRoots();
  const registryPath = opts.registryPath;
  const requestedPort = opts.port ?? HUB_PORT;

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let port = 0; // assigned once bound (below)
  let stopped = false;
  let notifying = false;
  let lastSnapshot = "";

  const snapshot = async (): Promise<string> =>
    JSON.stringify({ sessions: await listAll(roots, registryPath) });

  const broadcast = (frame: string): void => {
    const chunk = encoder.encode(frame);
    for (const client of sseClients) {
      try {
        client.enqueue(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  // Re-broadcast the current listing whenever it changes. Gated on having
  // subscribers so a quiet daemon does not re-scan the disk, and never tighter
  // than POLL_MS so there is no busy loop.
  const notify = async (): Promise<void> => {
    if (sseClients.size === 0 || notifying) return;
    notifying = true;
    try {
      const snap = await snapshot();
      if (snap === lastSnapshot) return;
      lastSnapshot = snap;
      broadcast(`data: ${snap}\n\n`);
    } finally {
      notifying = false;
    }
  };

  const handleEvents = (): Response => {
    let self!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        sseClients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
        // Prime the new subscriber with the current snapshot immediately.
        void (async () => {
          try {
            const snap = await snapshot();
            controller.enqueue(encoder.encode(`data: ${snap}\n\n`));
          } catch {
            // best-effort priming; the poll will catch up
          }
        })();
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

  const handle = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    const headerCheck = validateHeaders(req, port);
    if (!headerCheck.ok) return json({ error: `forbidden: ${headerCheck.reason}` }, 403);

    if (pathname === "/hub/sessions" && req.method === "GET") {
      return json({ sessions: await listAll(roots, registryPath) }, 200, noStore);
    }
    if (pathname === "/hub/events" && req.method === "GET") {
      return handleEvents();
    }
    if (pathname === "/") {
      return new Response(renderHubPage(await listAll(roots, registryPath)), {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      });
    }
    return json({ error: "not found" }, 404);
  };

  const server = Bun.serve({
    port: requestedPort,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      try {
        return await handle(req);
      } catch (err) {
        return json({ error: `daemon error: ${(err as Error).message}` }, 500);
      }
    },
  });
  port = server.port ?? 0;

  const timer = setInterval(() => void notify(), POLL_MS);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const client of sseClients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    sseClients.clear();
    await server.stop(true);
  };

  return { port, stop };
};
