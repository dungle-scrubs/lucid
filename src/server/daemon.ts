import { createHash } from "node:crypto";
import { migrateLegacySessionDir } from "../core/session.ts";
import { dirname, join, resolve as resolvePath } from "node:path";
import { lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { canonicalArtifactPath, sessionPaths, type SessionPaths } from "../core/paths.ts";
import {
  addRoot,
  defaultRoots,
  listAll,
  readRoots,
  registerSession,
  type RegistryEntry,
  scanRoots,
} from "../core/registry.ts";
import {
  discoverLiveServer,
  loopbackFetch,
  removeServerDescriptor,
  readServerDescriptor,
  writeServerDescriptor,
} from "./discovery.ts";
import { escapeHtml } from "../core/escape.ts";
import { sseMaxBackoffFromEnv } from "./viewer.ts";
import { scratchpadProject } from "../core/scratchpad.ts";
import { projectRoot } from "../core/sessions.ts";
import { parseTitle, TITLE_SCAN_BYTES } from "../core/title.ts";
import { detectUsageLimit } from "../launch/limits.ts";
import { runSpawn } from "../launch/launcher.ts";
import { buildArgv, loadRegistry, normalizeHarness, resolveRecipe } from "../launch/recipes.ts";
import {
  insertSelectionArgs,
  sanitizeSelection,
  selectionArgs,
  writeSelection,
} from "../launch/selection.ts";
import type { HarnessInfo } from "../protocol/wire.ts";
import { createArtifactPrompt, createAttendant, type Attendant } from "./attend.ts";
import {
  CHROME_BUNDLE,
  CHROME_CSS,
  CLIENT_BUNDLE,
  CLIENT_BUNDLE_HASH,
  FAVICON_SVG,
} from "./client-bundle.generated.ts";
import { devBundleStamp, readDevAsset } from "./dev-assets.ts";
import { injectOverlay } from "./inject.ts";
import { hubPort, portBase } from "./ports.ts";
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
 * It never spawns agents WITHOUT explicit opt-in (D-064, as amended by D15):
 * by default agent-spawning stays in the opt-in fork launcher and a
 * review-only install is inert. Started with `attend`, the hub additionally
 * runs the delivery engine (attend.ts) - a headless turn per undelivered
 * feedback batch when nothing is listening - and answers `POST /hub/create`.
 * Binds 127.0.0.1 only, behind the same Host/Origin gate the per-session
 * server uses.
 */
export const HUB_PORT = hubPort(portBase(process.env));

/** How often the SSE change-detector re-scans while subscribers are connected. */
const POLL_MS = 2000;

/** Idle window before a hosted session is suspended and evicted (ms). */
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/** How often each mount's delivery watcher evaluates, in attend mode. */
const DEFAULT_ATTEND_POLL_MS = 1000;

/** A new artifact's filename, as `POST /hub/create` accepts it: a plain
 *  `.html` basename, never a path - the project root comes from the listing
 *  and the two are joined here, so no traversal is expressible. */
const CREATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.html$/;

/** Upper bound on a create request's prompt (chars). */
const MAX_CREATE_PROMPT = 4000;

/** Opaque, stable session id: a canonical artifact path, hashed. Opaque
 *  because raw absolute paths do not belong in URLs (decision 5). */
export const sessionId = (artifactPath: string): string =>
  createHash("sha256").update(canonicalArtifactPath(artifactPath)).digest("hex").slice(0, 16);

export interface DaemonOptions {
  /** Bind port. Default `HUB_PORT`; pass 0 to bind an ephemeral port. */
  readonly port?: number;
  /** Discovery roots for `listAll`. Default `~/dev`. Folders added through
   *  `POST /hub/roots` are scanned ON TOP of these. */
  readonly roots?: readonly string[];
  /** Injected registry file path (tests). Default `<home>/.lucid/registry.json`. */
  readonly registryPath?: string;
  /** Injected added-roots file path (tests). Default `<home>/.lucid/roots.json`. */
  readonly rootsPath?: string;
  /** Idle window before a hosted session suspends + evicts (ms; tests). */
  readonly sessionIdleMs?: number;
  /**
   * Attend mode (D15): the hub delivers undelivered feedback itself by
   * spawning the artifact's own harness session, and answers
   * `POST /hub/create`. Off by default - D-064 as amended still requires an
   * explicit opt-in before this process spawns anything.
   */
  readonly attend?: boolean;
  /** Injected harness-registry path (tests). Default: the recipes resolution
   *  ($LUCID_HARNESSES, else XDG). */
  readonly harnessesPath?: string;
  /** Quiet window before an undelivered batch is driven (ms; tests). */
  readonly attendDebounceMs?: number;
  /** How often each mount's delivery watcher evaluates (ms; tests). */
  readonly attendPollMs?: number;
  /** Activity sink for attend-mode lines. Defaults to stdout. */
  readonly log?: (message: string) => void;
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
 *  its opaque mount id, its project, and whether a dedicated server is
 *  currently live. */
export interface HubSession extends RegistryEntry {
  readonly id: string;
  /** The artifact's own `<title>`, when it has one: what the shell puts on a
   *  tab. Absent for an artifact with no title (the filename stands in). */
  readonly title?: string;
  /** True when the daemon itself hosts it right now (stream + appends). */
  readonly hosted: boolean;
  /** The session's project root (nearest .git, else the artifact's own
   *  directory; a worktree resolves to its MAIN repo). A tab is a SESSION;
   *  the project is a grouping - this is what the shell groups by. */
  readonly project: string;
  /** Present when the session lives in a git worktree: that checkout's
   *  root, shown as a qualifier under its main project. */
  readonly worktree?: string;
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
<script>window.__LUCID_SHELL__ = { mode: "shell"${(() => {
  const backoff = sseMaxBackoffFromEnv();
  return backoff === undefined ? "" : `, sseMaxBackoffMs: ${backoff}`;
})()} };</script>
<div id="lucid-root"></div>
<script type="module" src="/__lucid/chrome.js"></script>
</body>
</html>`;

/**
 * Start the hub daemon. Foreground callers keep the returned handle and await
 * their own shutdown; tests pass `port: 0` and call `stop()`.
 */
export const runDaemon = async (opts: DaemonOptions = {}): Promise<DaemonHandle> => {
  const configuredRoots = opts.roots ?? defaultRoots();
  const registryPath = opts.registryPath;
  const rootsPath = opts.rootsPath;

  /**
   * The roots a listing pass walks: the configured set plus every folder the
   * human has added. Read PER PASS rather than captured at startup, so a
   * folder added through `POST /hub/roots` takes effect on the next listing
   * instead of at the next hub restart.
   */
  const scanRootSet = async (): Promise<string[]> => [
    ...new Set([...configuredRoots, ...(await readRoots(rootsPath))]),
  ];
  const requestedPort = opts.port ?? HUB_PORT;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const attend = opts.attend === true;
  const attendPollMs = opts.attendPollMs ?? DEFAULT_ATTEND_POLL_MS;
  const log = opts.log ?? ((m: string) => process.stdout.write(`${m}\n`));

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
    /** Attend mode only: this artifact's delivery watcher and its timer. */
    readonly attendant?: Attendant;
    readonly attendTimer?: ReturnType<typeof setInterval>;
  }

  /** Artifact paths a `POST /hub/create` turn is currently authoring. The
   *  file does not exist until the agent writes it, so the "does it exist"
   *  check cannot see an authoring run in progress. */
  const creating = new Set<string>();

  /** id -> artifact path, refreshed from every listing pass. The id space is
   *  derived (hash of path), so this map is a cache, not a source of truth. */
  const idToArtifact = new Map<string, string>();
  /** Sessions the daemon itself hosts right now, by id. */
  const mounts = new Map<string, Mount>();

  const rememberIds = (entries: readonly RegistryEntry[]): void => {
    for (const e of entries) idToArtifact.set(sessionId(e.artifact), e.artifact);
  };

  /** Project identity is stable for a given artifact path; the listing runs
   *  every poll tick, so the .git resolution happens once per artifact, not
   *  per tick. */
  const projectCache = new Map<string, { project: string; worktree?: string }>();

  /**
   * A session's project, worktree-aware: a git WORKTREE's `.git` is a file
   * pointing at `<main>/.git/worktrees/<name>`, and the drawer groups
   * worktrees under their MAIN repo even though they live in other
   * directories. `project` is always the grouping root; `worktree` names the
   * checkout when it differs.
   */
  const groupingFor = async (root: string): Promise<{ project: string; worktree?: string }> => {
    try {
      const gitPath = join(root, ".git");
      if ((await stat(gitPath)).isFile()) {
        const raw = await readFile(gitPath, "utf8");
        const m = /^gitdir:\s*(.+)$/m.exec(raw);
        if (m?.[1]) {
          const gitdir = resolvePath(root, m[1].trim());
          const wt = /^(.*)[/]\.git[/]worktrees[/][^/]+[/]?$/.exec(gitdir);
          if (wt?.[1]) return { project: wt[1], worktree: root };
        }
      }
    } catch {
      /* plain .git directory, or unreadable: the root is the project */
    }
    return { project: root };
  };

  const resolveProject = async (
    artifact: string,
  ): Promise<{ project: string; worktree?: string }> => {
    const cached = projectCache.get(artifact);
    if (cached !== undefined) return cached;
    // An artifact in an agent's scratchpad belongs to the project that agent
    // was WORKING ON, not to the scratchpad - which is one session's workspace
    // and would label every such row "scratchpad". The decoded cwd then goes
    // through the same worktree resolution as any checkout, because a cwd is
    // routinely a worktree.
    const spProject = await scratchpadProject(dirname(artifact));
    const root = spProject ?? (await projectRoot(sessionPaths(artifact)));
    const resolved = await groupingFor(root);
    projectCache.set(artifact, resolved);
    return resolved;
  };

  /**
   * An artifact's `<title>`, cached against its mtime: the listing re-scans
   * every POLL_MS, and re-reading every artifact's head each time would make
   * a quiet hub do steady disk work for a string that only changes when the
   * agent revises the file.
   */
  const titleCache = new Map<string, { readonly mtimeMs: number; readonly title: string | null }>();
  const readTitle = async (artifact: string): Promise<string | null> => {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(artifact)).mtimeMs;
    } catch {
      return null; // an artifact that is not there has no title to show
    }
    const hit = titleCache.get(artifact);
    if (hit && hit.mtimeMs === mtimeMs) return hit.title;
    let title: string | null = null;
    try {
      const fd = await open(artifact, "r");
      try {
        const buf = Buffer.alloc(TITLE_SCAN_BYTES);
        const { bytesRead } = await fd.read(buf, 0, TITLE_SCAN_BYTES, 0);
        title = parseTitle(buf.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await fd.close();
      }
    } catch {
      title = null;
    }
    titleCache.set(artifact, { mtimeMs, title });
    return title;
  };

  const listHub = async (): Promise<HubSession[]> => {
    const entries = await listAll(await scanRootSet(), registryPath);
    rememberIds(entries);
    return Promise.all(
      entries.map(async (e) => {
        const id = sessionId(e.artifact);
        const proj = await resolveProject(e.artifact);
        const title = await readTitle(e.artifact);
        return {
          ...e,
          id,
          hosted: mounts.has(id),
          project: proj.project,
          ...(title !== null ? { title } : {}),
          ...(proj.worktree ? { worktree: proj.worktree } : {}),
        };
      }),
    );
  };

  /** Unmount a hosted session: close its streams/watchers and release the
   *  descriptor if it is ours. Appends nothing (suspend is the caller's call). */
  const evict = async (id: string): Promise<void> => {
    const mount = mounts.get(id);
    if (!mount) return;
    mounts.delete(id);
    clearInterval(mount.idleTimer);
    if (mount.attendTimer) clearInterval(mount.attendTimer);
    mount.attendant?.stop();
    mount.host.stop();
    // Only remove OUR descriptor: a dedicated server that took over meanwhile
    // owns the file now.
    const desc = await readServerDescriptor(mount.paths);
    if (desc && desc.pid === process.pid) await removeServerDescriptor(mount.paths);
  };

  /** Host a session in-process (idempotent). The caller has already ruled out
   *  a live dedicated server. All-or-nothing: a mount that cannot finish
   *  (say, a descriptor write into a deleted session dir) must not stay half
   *  registered - that made the first request 500 and the retry "work". */
  const mount = async (id: string, artifact: string): Promise<Mount> => {
    if (stopped) throw new Error("daemon is stopping");
    const existing = mounts.get(id);
    if (existing) return existing;
    const paths = sessionPaths(artifact);
    // Sessions recorded before the record moved out of `.lucid/` are listed by
    // the scan and must OPEN, not just appear: mounting one moves it forward.
    migrateLegacySessionDir(paths);
    const base = `/s/${id}`;
    const host = createSessionHost(paths, {
      getPort: () => port,
      base,
      // The mount's selection route validates against the SAME registry the
      // hub's create and attend paths use (tests inject their own).
      ...(opts.harnessesPath !== undefined ? { harnessesPath: opts.harnessesPath } : {}),
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
    // Attend mode: one delivery watcher per mount, reading THIS session's
    // listener count so a live interactive attendant always wins.
    const attendant = attend
      ? createAttendant({
          paths,
          agentsListening: () => host.agentsListening(),
          warn: (code, message) => host.warn(code, message),
          ...(opts.harnessesPath !== undefined ? { harnessesPath: opts.harnessesPath } : {}),
          ...(opts.attendDebounceMs !== undefined ? { debounceMs: opts.attendDebounceMs } : {}),
          log,
        })
      : undefined;
    // Evaluate immediately, not a poll interval from now: the first pass adopts
    // the log's high seq as delivered, so anything appended before it would be
    // read as already-taken backlog.
    if (attendant) void attendant.tick();
    const attendTimer = attendant
      ? setInterval(() => void attendant.tick(), attendPollMs)
      : undefined;
    const created: Mount = {
      paths,
      host,
      idleTimer,
      ...(attendant ? { attendant } : {}),
      ...(attendTimer ? { attendTimer } : {}),
    };
    mounts.set(id, created);
    try {
      await writeServerDescriptor(paths, {
        port,
        pid: process.pid,
        session: paths.artifactPath,
        startedAt: new Date().toISOString(),
        base,
      });
    } catch (err) {
      mounts.delete(id);
      clearInterval(idleTimer);
      if (attendTimer) clearInterval(attendTimer);
      attendant?.stop();
      host.stop();
      throw err;
    }
    return created;
  };

  /** Hop-by-hop and trust-bearing headers that must not travel through the
   *  proxy: loopbackFetch sets its own Host, and a forwarded Origin would
   *  make the inner server's gate reject the shell's legitimate writes
   *  (its port differs) while a forged one could smuggle trust. */
  const sanitizedProxyHeaders = (req: Request): Headers => {
    const headers = new Headers(req.headers);
    for (const h of ["host", "origin", "connection", "keep-alive", "transfer-encoding"]) {
      headers.delete(h);
    }
    return headers;
  };

  /**
   * Route a `/s/<id>/…` request: to our own mount, or - when a dedicated
   * server is live for that session - proxied to it, so one origin shows
   * every session without ever creating a second appender.
   *
   * The caller has already gated the request (Host/Origin) against the HUB
   * port; the mount gates again with the same rules, and the proxy forwards
   * only sanitized headers, so the inner server never sees a Host or Origin
   * this daemon did not vouch for.
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
      rememberIds(await listAll(await scanRootSet(), registryPath));
      artifact = idToArtifact.get(id);
      if (artifact === undefined) return json({ error: "unknown session" }, 404);
    }

    const mounted = mounts.get(id);
    if (mounted) return mounted.host.handle(req, subPath);

    const paths = sessionPaths(artifact);

    // No session data on disk = nothing to host. A registry pointer can
    // outlive its session (self-healed on the next listing pass); mounting
    // the husk would serve empty state as if it were real.
    const hasLog = await stat(paths.logPath).then(
      () => true,
      () => false,
    );
    if (!hasLog) return json({ error: "session data is gone from disk" }, 404);

    // A descriptor naming OUR port with no mount behind it is a leftover from
    // a previous hub life on this port. Handshaking it would call back into
    // this very route and recurse; mounting simply replaces it.
    const stale = await readServerDescriptor(paths);
    const live = stale && stale.port === port ? undefined : await discoverLiveServer(paths);

    if (live && live.port !== port) {
      // A dedicated server owns this session - proxy, never double-host.
      // Two routes are answered locally even then, because the inner server
      // renders them for base "" and they would break under the mount, and
      // both are pure reads of shared state:
      // - the artifact document (its overlay bootstrap must resolve to
      //   /s/<id>/__lucid/client.js, not the hub root);
      // - the overlay bundle itself (served at the router, pre-resolution).
      if (subPath === "/" && req.method === "GET") {
        const html = await readFile(paths.currentHtml, "utf8").catch(() => null);
        if (html === null) return json({ error: "artifact not available" }, 404);
        return new Response(injectOverlay(html, `/s/${id}`), {
          headers: { "content-type": "text/html; charset=utf-8", ...noStore },
        });
      }
      const url = new URL(req.url);
      const init: RequestInit = {
        method: req.method,
        headers: sanitizedProxyHeaders(req),
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body }),
      };
      return loopbackFetch(live.port, `${subPath}${url.search}`, init);
    }

    const m = await mount(id, artifact);
    return m.host.handle(req, subPath);
  };

  // ---- hub listing + events ---------------------------------------------------

  const snapshot = async (): Promise<string> => {
    // The bundle stamp rides every snapshot: the watcher's file mtime in dev
    // mode, the embedded build hash in production. Either way, when a shell
    // reconnects to a hub running NEWER UI than it is, the stamp differs and
    // the shell reloads itself - a hub restart updates live windows instead
    // of leaving them on the old bundle.
    const stamp = devBundleStamp() ?? CLIENT_BUNDLE_HASH;
    return JSON.stringify({ sessions: await listHub(), bundle: stamp });
  };

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
    // Tell open shell windows to surface this session as a tab NOW. The CLI
    // reads `shells` to decide whether a window took it - if one did, it
    // skips the default browser entirely (opening in Arc next to a live
    // shell window was the bug).
    broadcast(`event: open-tab\ndata: ${JSON.stringify({ id })}\n\n`);
    return json({
      ok: true,
      id,
      base: `/s/${id}`,
      shell: `http://127.0.0.1:${port}/?s=${id}`,
      shells: sseClients.size,
    });
  };

  /**
   * `POST /hub/create {project, name, prompt, harness?}` - create from nothing
   * (D3/D16): mint a NEW artifact by running the harness registry's spawn
   * recipe with an author-this-artifact prompt. Attend mode only; a review-only
   * hub answers 403.
   *
   * The target path is never taken from the caller: `project` must be a root
   * the current listing already reports, `name` is a bare `.html` basename, and
   * the two are joined here - so no request can name a path outside a project
   * the hub already knows. Every value reaches the harness as argv.
   */
  const handleHubCreate = async (req: Request): Promise<Response> => {
    if (!attend) {
      return json({ error: "create requires the hub's attend mode (lucid hub --attend)" }, 403);
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const project = typeof body?.project === "string" ? body.project : "";
    const name = typeof body?.name === "string" ? body.name : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    // The document's own name, bounded and control-stripped like every other
    // human string that rides into a spawn argv.
    const title =
      typeof body?.title === "string"
        ? body.title
            .split("")
            .filter((ch) => {
              const c = ch.codePointAt(0) ?? 0;
              return c >= 0x20 && c !== 0x7f;
            })
            .join("")
            .trim()
            .slice(0, 120)
        : "";
    const harness = typeof body?.harness === "string" && body.harness ? body.harness : undefined;
    // The human's model/effort pick for this artifact. Absent = the CLI
    // decides, and nothing is persisted.
    const selection = body
      ? sanitizeSelection({ model: body.model, effort: body.effort })
      : undefined;

    if (!CREATE_NAME.test(name)) {
      return json({ error: "name must be a plain .html filename" }, 400);
    }
    if (prompt.trim().length === 0 || prompt.length > MAX_CREATE_PROMPT) {
      return json({ error: `prompt must be 1..${MAX_CREATE_PROMPT} characters` }, 400);
    }
    const listing = await listHub();
    // A worktree is a listed root of its own, grouped under its main repo -
    // both are legitimate create targets; anything else is not a project the
    // hub knows about.
    const known = listing.some((s) => s.project === project || s.worktree === project);
    if (!known) return json({ error: "unknown project" }, 400);
    // Listed is not the same as PRESENT. A project can be deleted while its
    // reviews outlive it, and a scratchpad session's project is recovered from
    // an encoded path whose deepest component may no longer exist - authoring
    // there would silently mkdir -p a directory tree nobody asked for. A
    // listing is a place to READ reviews from; writing needs the real thing.
    const projectPresent = await stat(project).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!projectPresent) {
      return json({ error: "that project's folder no longer exists on disk" }, 409);
    }

    const artifact = join(project, name);
    // lstat, not stat: a DANGLING symlink is absent to stat, and creating
    // "into" it would write the artifact wherever the link points - outside
    // the project the request was allowed to name.
    const exists = await lstat(artifact).then(
      () => true,
      () => false,
    );
    if (exists) return json({ error: "an artifact with that name already exists" }, 409);
    // Claim the path for the rest of this request: the existence check above
    // and the spawn below are separated by awaits, and two windows submitting
    // the same name would otherwise both pass and both author one file.
    if (creating.has(artifact)) {
      return json({ error: "an artifact with that name is already being authored" }, 409);
    }
    creating.add(artifact);
    /** The spawn owns the claim once it starts; every other exit releases it. */
    let handedOff = false;
    try {
      const registry = await loadRegistry(opts.harnessesPath);
      const resolved = registry ? resolveRecipe(registry, harness) : undefined;
      // An explicitly named harness must exist: falling back to the default
      // would silently author with a different agent than the one asked for.
      if (
        !resolved ||
        (harness !== undefined && normalizeHarness(resolved.name) !== normalizeHarness(harness))
      ) {
        return json({ error: `no spawn recipe for harness "${harness ?? "(default)"}"` }, 400);
      }

      // A pick the recipe does not offer fails HERE, with the adapter's own
      // words, rather than as an agent turn that dies on an unknown flag.
      const selArgs = selection ? selectionArgs(resolved.name, resolved.recipe, selection) : [];
      if ("error" in selArgs) return json({ error: selArgs.error }, 400);

      // The child is its own harness session from birth (D18): the id is minted
      // here so the stamps it writes name a conversation that can be resumed.
      const childSessionId = crypto.randomUUID();
      const paths = sessionPaths(artifact);
      const argv = insertSelectionArgs(
        resolved.name,
        buildArgv(resolved.recipe.spawn, {
          id: childSessionId,
          artifact,
          cwd: project,
          prompt: createArtifactPrompt(artifact, prompt, title || undefined),
        }),
        selArgs,
        resolved.recipe.spawn,
      );
      await mkdir(paths.sessionDir, { recursive: true });
      // The pick STICKS to the artifact: every later unattended resume reads
      // this sidecar rather than re-deriving a model from the registry.
      if (selection) {
        await writeSelection(paths, { harness: resolved.name, ...selection });
      }
      log(`create ${name}: spawning "${resolved.name}" in ${project}`);
      // Answer immediately: authoring is a whole agent turn, and the artifact
      // surfaces as a tab on its own `lucid open`. The claim is held until the
      // turn ends, so a retry while it runs is refused rather than doubled.
      const outLog = join(paths.sessionDir, "create.out.log");
      // A dead create turn is knowable the moment the child exits - waiting
      // out the dialog's own patience to report "check the log" turned a
      // seconds-fast failure (a harness over its usage limit) into two
      // minutes of mystery silence. Broadcast the exit with the log's tail
      // so the dialog can say what actually happened, immediately.
      const reportFailure = async (code: number | string): Promise<void> => {
        const raw = await readFile(outLog, "utf8").catch(() => "");
        const tail = raw.trim().split("\n").slice(-3).join("\n").slice(-500);
        // A usage wall is the one failure the human can do nothing about in
        // Lucid - name it as such rather than leaving them to read the tail.
        const usageLimit = detectUsageLimit(raw);
        broadcast(
          `event: create-failed\ndata: ${JSON.stringify({
            artifact,
            code,
            tail,
            ...(usageLimit !== null ? { usageLimit } : {}),
          })}\n\n`,
        );
      };
      void runSpawn(argv, project, outLog, {
        harness: resolved.name,
        sessionId: childSessionId,
        ...(selection?.model !== undefined ? { model: selection.model } : {}),
        ...(selection?.effort !== undefined ? { effort: selection.effort } : {}),
      })
        .then((code) => {
          if (code !== 0) {
            log(`create ${name}: create turn exited ${code}`);
            void reportFailure(code);
          }
        })
        .catch((err) => {
          log(`create ${name}: create turn failed: ${(err as Error).message}`);
          void reportFailure("spawn-error");
        })
        .finally(() => creating.delete(artifact));
      handedOff = true;

      return json({ ok: true, artifact }, 202);
    } finally {
      if (!handedOff) creating.delete(artifact);
    }
  };

  /**
   * Resolve the folder a `{path?}` request names: an explicit absolute path,
   * or - with none - the macOS folder chooser. Answers with the validated
   * directory, or with the Response to send instead (the human cancelled, no
   * chooser exists here, the path is bad). Shared by the two routes that take
   * a folder: `/hub/project` (where to AUTHOR) and `/hub/roots` (where to LOOK).
   *
   * `prompt` reaches AppleScript as source, so it stays an internal literal -
   * never request data.
   */
  const chooseFolder = async (
    body: Record<string, unknown> | null,
    prompt: string,
  ): Promise<{ readonly dir: string } | { readonly res: Response }> => {
    let picked = typeof body?.path === "string" ? body.path.trim() : "";
    if (picked === "") {
      if (process.platform !== "darwin") {
        return {
          res: json({ error: "no folder chooser here - type or paste a path instead" }, 501),
        };
      }
      // AppleScript returns an alias; POSIX path makes it a real path. A
      // cancel exits non-zero, which is not an error to report - the human
      // simply changed their mind.
      // Activated first, and shown BY System Events: an unactivated osascript
      // puts its chooser behind the window the human is looking at, which is
      // indistinguishable from the button doing nothing.
      const proc = Bun.spawn(
        [
          "osascript",
          "-e",
          'tell application "System Events"',
          "-e",
          "activate",
          "-e",
          `set picked to choose folder with prompt "${prompt}"`,
          "-e",
          "end tell",
          "-e",
          "POSIX path of picked",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) return { res: json({ cancelled: true }, 200, noStore) };
      picked = out.trim();
    }
    if (!picked.startsWith("/")) return { res: json({ error: "an absolute path, please" }, 400) };
    const dir = resolvePath(picked);
    try {
      if (!(await stat(dir)).isDirectory()) return { res: json({ error: "not a directory" }, 400) };
    } catch {
      return { res: json({ error: "no such directory" }, 400) };
    }
    return { dir };
  };

  /**
   * `POST /hub/roots {path?}` - add a folder to the scanned set, so the
   * sessions already inside it (`<folder>/**​/.lucid/<stem>/log.ndjson`) join
   * the listing, and keep joining it after a restart.
   *
   * `~/dev` is a GUESS about where artifacts live; this is how a human corrects
   * it - a scratchpad an agent writes to, a checkout somewhere else entirely.
   *
   * Deliberately NOT attend-gated, unlike `/hub/project`: pointing the hub at
   * a folder is a READ, and the hub `lucid app` starts is review-only. Gating
   * discovery behind attend mode is what left a cold-start shell with nothing
   * to do but read a CLI hint.
   *
   * The answer reports what the folder HELD, because "added" alone leaves the
   * human wondering whether they picked the right one.
   */
  const handleHubRoots = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const chosen = await chooseFolder(body, "Choose a folder to scan for Lucid sessions");
    if ("res" in chosen) return chosen.res;
    await addRoot(chosen.dir, rootsPath);
    // Counted from a scan of JUST this folder - `listAll` would union the
    // registry and report sessions that have nothing to do with the pick.
    const found = await scanRoots([chosen.dir]);
    // Connected shells are told by the listing stream, not by this response:
    // adding a root changes what EVERY window sees, not just this one's.
    void notify();
    // The EFFECTIVE set, not just the persisted additions: this is what the
    // shell displays as "looking in", and answering with the additions alone
    // made it forget the defaults (`~/dev`, the scratchpads) it still scans.
    return json(
      { root: chosen.dir, roots: await scanRootSet(), found: found.length },
      200,
      noStore,
    );
  };

  /**
   * `POST /hub/project {path?}` - name a project the listing does not know
   * yet, so a new artifact can be authored somewhere with no sessions in it.
   *
   * The answer runs through the same `resolveProject` the listing uses, so a
   * WORKTREE comes back as its main repo with the checkout named beside it -
   * the two are related by git itself, not by anything the human declares.
   *
   * Attend-only, like create: authoring is what this folder is FOR, and a
   * review-only hub stays a process that spawns nothing (D-064). Pointing the
   * hub at existing sessions is `/hub/roots`, which is open to every hub.
   */
  const handleHubProject = async (req: Request): Promise<Response> => {
    if (!attend) {
      return json({ error: "this hub does not author artifacts (start it with --attend)" }, 403);
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const chosen = await chooseFolder(body, "Choose a project folder for the new artifact");
    if ("res" in chosen) return chosen.res;
    const dir = chosen.dir;
    // resolveProject reads an ARTIFACT's location, so ask it about a file that
    // would live directly in this folder. Nothing is created or written.
    const proj = await resolveProject(join(dir, "artifact.html"));
    return json(
      { project: proj.project, ...(proj.worktree ? { worktree: proj.worktree } : {}), chosen: dir },
      200,
      noStore,
    );
  };

  const handle = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    const sessionMatch = /^\/s\/([a-f0-9]{16})(\/.*)?$/.exec(pathname);

    // The overlay bundle is the ONE pre-gate route (the sandboxed artifact
    // iframe loads it from an opaque origin). It is the same static bytes
    // for every session, so it is served here at the router - reaching it
    // must never resolve ids, scan the registry, or mount anything.
    if (sessionMatch && sessionMatch[2] === "/__lucid/client.js") {
      const headers: Record<string, string> = {
        "content-type": "text/javascript; charset=utf-8",
        "access-control-allow-origin": req.headers.get("origin") ?? "*",
        "access-control-allow-credentials": "true",
        ...noStore,
      };
      if (req.headers.get("origin") !== null) headers.vary = "Origin";
      return new Response((await readDevAsset("client.js")) ?? CLIENT_BUNDLE, { headers });
    }

    // EVERYTHING else - hub routes and session mounts alike - sits behind
    // the Host/Origin gate. Session routes are gated here, before any id
    // resolution or mounting: the proxy branch rewrites Host for loopback
    // delivery, so an ungated pass-through would let a DNS-rebound request
    // ride that rewrite past the inner server's own gate.
    const headerCheck = validateHeaders(req, port);
    if (!headerCheck.ok) return json({ error: `forbidden: ${headerCheck.reason}` }, 403);

    if (sessionMatch?.[1]) {
      // A slashless mount URL would make the document's RELATIVE references
      // resolve against /s/ instead of /s/<id>/ - normalize before serving,
      // keeping the query string.
      if (sessionMatch[2] === undefined) {
        const { search } = new URL(req.url);
        return new Response(null, {
          status: 308,
          headers: { location: `/s/${sessionMatch[1]}/${search}` },
        });
      }
      return handleSessionRoute(req, sessionMatch[1], sessionMatch[2] || "/");
    }

    if (pathname === "/hub/identity" && req.method === "GET") {
      // `shells` = connected listing subscribers, i.e. open shell windows.
      // `lucid app` uses it to update the live window instead of stacking
      // a new one per invocation.
      // `attend` tells a shell whether this hub spawns at all - the create
      // affordance is pointless (and 403s) on a review-only hub.
      // `harnesses`/`defaultHarness` name the registry's spawn recipes so the
      // create dialog can OFFER them - a free-text harness field asked the
      // human to recall magic strings. Read fresh per call: identity is
      // fetched on (re)connect only, and the registry is a small local file.
      // `harnessInfo` runs PARALLEL to `harnesses` (additive): the same names,
      // plus each recipe's curated model/effort vocabulary so the create
      // dialog can offer pickers. An older shell reads `harnesses` and never
      // sees it; a recipe declaring neither reports name-only, and the dialog
      // shows no pickers for it.
      const registry = await loadRegistry(opts.harnessesPath).catch(() => null);
      const harnesses = registry ? Object.keys(registry.harnesses) : [];
      const harnessInfo: HarnessInfo[] = Object.entries(registry?.harnesses ?? {}).map(
        ([name, recipe]) => ({
          name,
          ...(recipe.models ? { models: recipe.models } : {}),
          ...(recipe.defaultModel !== undefined ? { defaultModel: recipe.defaultModel } : {}),
          ...(recipe.efforts ? { efforts: recipe.efforts } : {}),
          ...(recipe.defaultEffort !== undefined ? { defaultEffort: recipe.defaultEffort } : {}),
        }),
      );
      // `roots` names the folders being scanned, so an empty shell can say
      // WHERE it looked instead of just "no reviews yet" - the difference
      // between a dead end and a correctable guess.
      return json(
        {
          lucid: "hub",
          port,
          shells: sseClients.size,
          attend,
          roots: await scanRootSet(),
          harnesses,
          harnessInfo,
          ...(registry?.default !== undefined ? { defaultHarness: registry.default } : {}),
        },
        200,
        noStore,
      );
    }
    if (pathname === "/hub/sessions" && req.method === "GET") {
      return json({ sessions: await listHub() }, 200, noStore);
    }
    if (pathname === "/hub/open" && req.method === "POST") {
      return handleHubOpen(req);
    }
    if (pathname === "/hub/create" && req.method === "POST") {
      return handleHubCreate(req);
    }
    if (pathname === "/hub/project" && req.method === "POST") {
      return handleHubProject(req);
    }
    if (pathname === "/hub/roots" && req.method === "POST") {
      return handleHubRoots(req);
    }
    if (pathname === "/hub/events" && req.method === "GET") {
      return handleEvents();
    }
    // The shell's own bundle + stylesheet, same generated artifacts every
    // session mount serves - the chrome is one bundle in two modes.
    if (pathname === "/__lucid/chrome.js") {
      return new Response((await readDevAsset("chrome.js")) ?? CHROME_BUNDLE, {
        headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/chrome.css") {
      return new Response((await readDevAsset("chrome.css")) ?? CHROME_CSS, {
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

/** Strict LUCID_HUB_PORT parse: full-string digits in the TCP range, or
 *  nothing. `parseInt` would accept "17428garbage" and NaN would reach
 *  fetch/Bun.serve as a port. */
export const parseHubPort = (raw: string | undefined): number | undefined => {
  if (!raw || !/^\d{1,5}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : undefined;
};

/** What a live hub reports about itself. */
export interface HubInfo {
  readonly port: number;
  /** Connected shell windows (listing-stream subscribers). */
  readonly shells: number;
  /** True when the hub runs the attend engine (headless turns + create). */
  readonly attend: boolean;
}

/** The hub's identity on `port`, or undefined when none answers. */
export const hubInfo = async (port = HUB_PORT): Promise<HubInfo | undefined> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HUB_PROBE_TIMEOUT_MS);
    const probe = await loopbackFetch(port, "/hub/identity", { signal: controller.signal });
    clearTimeout(timer);
    if (!probe.ok) return undefined;
    const who = (await probe.json()) as { lucid?: unknown; shells?: unknown; attend?: unknown };
    if (who.lucid !== "hub") return undefined;
    return {
      port,
      shells: typeof who.shells === "number" ? who.shells : 0,
      attend: who.attend === true,
    };
  } catch {
    return undefined;
  }
};

/** True when a hub daemon answers its identity probe on `port`. */
export const hubAlive = async (port = HUB_PORT): Promise<boolean> =>
  (await hubInfo(port)) !== undefined;

/** What `POST /hub/open` answers: where the session now lives on the hub. */
export interface HubOpenResult {
  readonly ok: true;
  readonly id: string;
  readonly base: string;
  readonly shell: string;
  /** Connected shell windows at open time. 0 means nobody is looking - the
   *  CLI falls back to opening a browser. */
  readonly shells?: number;
}

/**
 * Ask a running hub daemon to surface a session (register + mount + tab).
 * Returns undefined when no hub answers - the caller then falls back to the
 * dedicated per-session server, so a machine without the shell keeps the
 * exact pre-daemon behavior.
 */
export const hubOpen = async (
  artifact: string,
  port = parseHubPort(process.env.LUCID_HUB_PORT) ?? HUB_PORT,
): Promise<HubOpenResult | undefined> => {
  try {
    if (!(await hubAlive(port))) return undefined;
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
