import { createHash } from "node:crypto";
import { canonicalArtifactPath, sessionPaths, type SessionPaths } from "../core/paths.ts";
import { defaultRoots, listAll, registerSession, type RegistryEntry } from "../core/registry.ts";
import {
  discoverLiveServer,
  loopbackFetch,
  removeServerDescriptor,
  readServerDescriptor,
  writeServerDescriptor,
} from "./discovery.ts";
import { escapeHtml } from "../core/escape.ts";
import { CHROME_BUNDLE, CHROME_CSS, FAVICON_SVG } from "./client-bundle.generated.ts";
import { validateHeaders } from "./security.ts";
import { createSessionHost, type SessionHost } from "./session-host.ts";

/**
 * The always-on hub daemon (Model B). One long-lived loopback process that
 * hosts EVERY session in-process, each mounted under an opaque id
 * (`/s/<id>/…`), and serves the shell UI at `/`. Data never moves: each
 * hosted session reads and writes its own `<project>/.lucid/<name>/` in
 * place, exactly as a dedicated per-session server does - the host body is
 * literally the same module (session-host.ts).
 *
 * Coexistence rule (one appender per session, D-049): if a session already
 * has a LIVE dedicated server, the daemon does not host it - it PROXIES
 * `/s/<id>/…` to that server, so the shell still shows it on one origin.
 * Only when no dedicated server answers does the daemon host in-process and
 * write the discovery descriptor (with its `base`), making itself the
 * session's server for `deliver` and the browser alike.
 *
 * It never spawns an agent (D-064): agent-spawning stays in the opt-in fork
 * launcher. Binds 127.0.0.1 only, behind the same Host/Origin gate the
 * per-session server uses.
 */
export const HUB_PORT = 17428;

/** How often the SSE change-detector re-scans while subscribers are connected. */
const POLL_MS = 2000;

/** Idle window before a hosted session is suspended and evicted (ms). */
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/** Opaque, stable session id: a canonical artifact path, hashed. Opaque
 *  because raw absolute paths do not belong in URLs (decision 5). */
export const sessionId = (artifactPath: string): string =>
  createHash("sha256").update(canonicalArtifactPath(artifactPath)).digest("hex").slice(0, 16);

export interface DaemonOptions {
  /** Bind port. Default `HUB_PORT`; pass 0 to bind an ephemeral port. */
  readonly port?: number;
  /** Discovery roots for `listAll`. Default `~/dev`. */
  readonly roots?: readonly string[];
  /** Injected registry file path (tests). Default `<home>/.lucid/registry.json`. */
  readonly registryPath?: string;
  /** Idle window before a hosted session suspends + evicts (ms; tests). */
  readonly sessionIdleMs?: number;
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

/** A hub-listed session as the shell consumes it: the registry pointer plus
 *  its opaque mount id and whether a dedicated server is currently live. */
export interface HubSession extends RegistryEntry {
  readonly id: string;
  /** True when the daemon itself hosts it right now (stream + appends). */
  readonly hosted: boolean;
}

/** The shell page: boots the chrome bundle in shell mode. The client fetches
 *  `/hub/sessions` and tails `/hub/events` itself - this page only carries the
 *  mode flag and the optional initially-active session id (?s=<id>). */
const renderShellPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="/favicon.ico" />
<title>${escapeHtml("Lucid")}</title>
<link rel="stylesheet" href="/__lucid/chrome.css" />
</head>
<body>
<script>window.__LUCID_SHELL__ = { mode: "shell" };</script>
<div id="lucid-root"></div>
<script type="module" src="/__lucid/chrome.js"></script>
</body>
</html>`;

/**
 * Start the hub daemon. Foreground callers keep the returned handle and await
 * their own shutdown; tests pass `port: 0` and call `stop()`.
 */
export const runDaemon = async (opts: DaemonOptions = {}): Promise<DaemonHandle> => {
  const roots = opts.roots ?? defaultRoots();
  const registryPath = opts.registryPath;
  const requestedPort = opts.port ?? HUB_PORT;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let port = 0; // assigned once bound (below)
  let stopped = false;
  let notifying = false;
  let lastSnapshot = "";

  // ---- session mounts -------------------------------------------------------

  interface Mount {
    readonly paths: SessionPaths;
    readonly host: SessionHost;
    readonly idleTimer: ReturnType<typeof setInterval>;
  }

  /** id -> artifact path, refreshed from every listing pass. The id space is
   *  derived (hash of path), so this map is a cache, not a source of truth. */
  const idToArtifact = new Map<string, string>();
  /** Sessions the daemon itself hosts right now, by id. */
  const mounts = new Map<string, Mount>();

  const rememberIds = (entries: readonly RegistryEntry[]): void => {
    for (const e of entries) idToArtifact.set(sessionId(e.artifact), e.artifact);
  };

  const listHub = async (): Promise<HubSession[]> => {
    const entries = await listAll(roots, registryPath);
    rememberIds(entries);
    return entries.map((e) => {
      const id = sessionId(e.artifact);
      return { ...e, id, hosted: mounts.has(id) };
    });
  };

  /** Unmount a hosted session: close its streams/watchers and release the
   *  descriptor if it is ours. Appends nothing (suspend is the caller's call). */
  const evict = async (id: string): Promise<void> => {
    const mount = mounts.get(id);
    if (!mount) return;
    mounts.delete(id);
    clearInterval(mount.idleTimer);
    mount.host.stop();
    // Only remove OUR descriptor: a dedicated server that took over meanwhile
    // owns the file now.
    const desc = await readServerDescriptor(mount.paths);
    if (desc && desc.pid === process.pid) await removeServerDescriptor(mount.paths);
  };

  /** Host a session in-process (idempotent). The caller has already ruled out
   *  a live dedicated server. */
  const mount = async (id: string, artifact: string): Promise<Mount> => {
    const existing = mounts.get(id);
    if (existing) return existing;
    const paths = sessionPaths(artifact);
    const base = `/s/${id}`;
    const host = createSessionHost(paths, {
      getPort: () => port,
      base,
      onEnded: () => void evict(id),
    });
    const idleTimer = setInterval(
      () => {
        if (Date.now() - host.lastActivityAt() > sessionIdleMs) {
          void (async () => {
            // Same semantics as a dedicated server's idle-suspend: subscribers
            // learn of it, the log records it, memory is released. The log is
            // untouched otherwise - reopening refolds.
            await host.suspend();
            await evict(id);
          })();
        }
      },
      Math.min(sessionIdleMs, 5000),
    );
    const created: Mount = { paths, host, idleTimer };
    mounts.set(id, created);
    await writeServerDescriptor(paths, {
      port,
      pid: process.pid,
      session: paths.artifactPath,
      startedAt: new Date().toISOString(),
      base,
    });
    return created;
  };

  /**
   * Route a `/s/<id>/…` request: to our own mount, or - when a dedicated
   * server is live for that session - proxied to it, so one origin shows
   * every session without ever creating a second appender.
   */
  const handleSessionRoute = async (
    req: Request,
    id: string,
    subPath: string,
  ): Promise<Response> => {
    let artifact = idToArtifact.get(id);
    if (artifact === undefined) {
      // Unknown id: refresh the derived map once (a session opened after the
      // last listing), then give up.
      rememberIds(await listAll(roots, registryPath));
      artifact = idToArtifact.get(id);
      if (artifact === undefined) return json({ error: "unknown session" }, 404);
    }

    const mounted = mounts.get(id);
    if (mounted) return mounted.host.handle(req, subPath);

    const paths = sessionPaths(artifact);
    const live = await discoverLiveServer(paths);
    if (live && live.port !== port) {
      // A dedicated server owns this session - proxy, never double-host.
      // The one exception is the viewer page: it must carry base "/s/<id>"
      // to address the daemon origin, and the dedicated server would render
      // base "". Serve it ourselves from the shared renderer via the mount
      // path? No - the viewer is exactly what the SHELL replaces; under the
      // daemon the chrome loads once at "/" and talks to `/s/<id>` routes.
      const url = new URL(req.url);
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body }),
      };
      return loopbackFetch(live.port, `${subPath}${url.search}`, init);
    }

    const m = await mount(id, artifact);
    return m.host.handle(req, subPath);
  };

  // ---- hub listing + events ---------------------------------------------------

  const snapshot = async (): Promise<string> => JSON.stringify({ sessions: await listHub() });

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

  /** `POST /hub/open {artifact}`: register + surface a session as a tab. The
   *  CLI has already run openSession (the lifecycle append is its job); the
   *  daemon records the pointer, resolves the mount id, and tells connected
   *  shells. It never spawns anything. */
  const handleHubOpen = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.artifact !== "string" || body.artifact.length === 0) {
      return json({ error: "invalid open" }, 400);
    }
    const artifact = canonicalArtifactPath(body.artifact);
    try {
      await registerSession(artifact, registryPath);
    } catch {
      /* the pointer is a discovery convenience; hosting still proceeds */
    }
    const id = sessionId(artifact);
    idToArtifact.set(id, artifact);
    // Mount eagerly (idempotent) so the descriptor exists the moment `open`
    // returns: `wait`'s presence waker and `deliver` discover the session
    // through it. Never over a live dedicated server - that stays the one
    // appender and we proxy to it instead.
    const live = await discoverLiveServer(sessionPaths(artifact));
    if (!live || live.port === port) await mount(id, artifact);
    lastSnapshot = ""; // force the next notify to fire even inside POLL_MS
    void notify();
    return json({ ok: true, id, base: `/s/${id}`, shell: `http://127.0.0.1:${port}/?s=${id}` });
  };

  const handle = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    // Session mounts do their own gating (identical logic) and must serve the
    // overlay bundle pre-gate; route to them before the hub's own gate.
    const sessionMatch = /^\/s\/([a-f0-9]{16})(\/.*)?$/.exec(pathname);
    if (sessionMatch?.[1]) {
      // A slashless mount URL would make the document's RELATIVE references
      // resolve against /s/ instead of /s/<id>/ - normalize before serving.
      if (sessionMatch[2] === undefined) {
        return new Response(null, {
          status: 308,
          headers: { location: `/s/${sessionMatch[1]}/` },
        });
      }
      return handleSessionRoute(req, sessionMatch[1], sessionMatch[2] || "/");
    }

    const headerCheck = validateHeaders(req, port);
    if (!headerCheck.ok) return json({ error: `forbidden: ${headerCheck.reason}` }, 403);

    if (pathname === "/hub/identity" && req.method === "GET") {
      return json({ lucid: "hub", port }, 200, noStore);
    }
    if (pathname === "/hub/sessions" && req.method === "GET") {
      return json({ sessions: await listHub() }, 200, noStore);
    }
    if (pathname === "/hub/open" && req.method === "POST") {
      return handleHubOpen(req);
    }
    if (pathname === "/hub/events" && req.method === "GET") {
      return handleEvents();
    }
    // The shell's own bundle + stylesheet, same generated artifacts every
    // session mount serves - the chrome is one bundle in two modes.
    if (pathname === "/__lucid/chrome.js") {
      return new Response(CHROME_BUNDLE, {
        headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/chrome.css") {
      return new Response(CHROME_CSS, {
        headers: { "content-type": "text/css; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/favicon.ico") {
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" },
      });
    }
    if (pathname === "/") {
      return new Response(renderShellPage(), {
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
    for (const id of [...mounts.keys()]) await evict(id);
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

const HUB_PROBE_TIMEOUT_MS = 500;

/** What `POST /hub/open` answers: where the session now lives on the hub. */
export interface HubOpenResult {
  readonly ok: true;
  readonly id: string;
  readonly base: string;
  readonly shell: string;
}

/**
 * Ask a running hub daemon to surface a session (register + mount + tab).
 * Returns undefined when no hub answers - the caller then falls back to the
 * dedicated per-session server, so a machine without the shell keeps the
 * exact pre-daemon behavior.
 */
export const hubOpen = async (
  artifact: string,
  port = process.env.LUCID_HUB_PORT ? Number.parseInt(process.env.LUCID_HUB_PORT, 10) : HUB_PORT,
): Promise<HubOpenResult | undefined> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HUB_PROBE_TIMEOUT_MS);
    const probe = await loopbackFetch(port, "/hub/identity", { signal: controller.signal });
    clearTimeout(timer);
    if (!probe.ok) return undefined;
    const who = (await probe.json()) as { lucid?: unknown };
    if (who.lucid !== "hub") return undefined;
    const res = await loopbackFetch(port, "/hub/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact }),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as HubOpenResult;
  } catch {
    return undefined;
  }
};
