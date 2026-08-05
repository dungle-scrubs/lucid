import { createHash } from "node:crypto";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import { attentionOf } from "../core/attention.ts";
import { recordPendingIdentity } from "../core/attendant.ts";
import {
  ARTIFACT_DIR,
  canonicalArtifactPath,
  sessionPaths,
  type SessionPaths,
} from "../core/paths.ts";
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
import { artifactDocumentResponse, shellResponse, viewerResponse } from "./viewer.ts";
import { projectOf } from "../core/project.ts";
import { swr } from "../core/swr.ts";
import { parseTitle, TITLE_SCAN_BYTES } from "../core/title.ts";
import { planTurn, runTurn, type TurnOutcome } from "../launch/turn.ts";
import { readEvents, sessionStateCacheStats, sessionStateSync } from "../core/log.ts";
import { createArtifactPrompt } from "../launch/prompts.ts";
import {
  defaultRecipe,
  type HarnessRegistry,
  loadRegistry,
  registryPath as harnessRegistryPath,
  resolveExactRecipe,
  type SpawnRecipe,
} from "../launch/recipes.ts";
import { sanitizeSelection, selectionArgs, writeSelection } from "../launch/selection.ts";
import { DEFAULT_FRAME, type HubFrame, type HubListing } from "../protocol/frames.ts";
import type {
  HubAttention,
  HubCreateAccepted,
  HubCreateRequest,
  HubIdentity,
  HubOpenRequest,
  HubOpenResult,
  HubRootsRequest,
  HubRootsResponse,
  HubSession,
  HubSessionsResponse,
} from "../protocol/hub.ts";
import type { HarnessInfo } from "../protocol/wire.ts";
import { createAttendant, type Attendant } from "./attend.ts";
import {
  cliRequestId,
  sinkStatus,
  type SinkStatus,
  REQUEST_ID_HEADER,
  resolveHubSink,
  type RequestObservation,
} from "./observe.ts";
import { setNarrationSink, warnUnknownSubsystems } from "../core/verbose.ts";
import { serveBundleAsset } from "./assets.ts";
import { CLIENT_BUNDLE_HASH } from "./client-bundle.generated.ts";
import { devBundleStamp } from "./dev-assets.ts";
import {
  createChannel,
  pumpSse,
  serveLoopback,
  upgradeOrRefuse,
  wantsUpgrade,
  wasUpgraded,
  type Subscriber,
  type Upgrade,
} from "./live.ts";
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

/** How long a folder chooser may stay open before the request gives up. A human
 *  browsing folders is slow on purpose, so this is a hang guard rather than an
 *  interaction budget: a dialog nobody can see must not hold the browser's
 *  fetch open for the life of the process. */
const CHOOSER_TIMEOUT_MS = 5 * 60 * 1000;

/** How long `POST /hub/roots` waits for the folder's session count before
 *  answering without it. The add is already persisted by then; this only
 *  decides whether the human is told how many sessions came with it. */
const ROOT_COUNT_BUDGET_MS = 2000;

/** A new artifact's filename, as `POST /hub/create` accepts it: a plain
 *  `.html` basename, never a path - the project root comes from the listing
 *  and the two are joined here, so no traversal is expressible. */
const CREATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.html$/;

/** How often a live create turn says it is still alive (M2.1). Frequent
 *  enough that the dialog can distinguish "running" from "the hub stopped
 *  reporting" within seconds, cheap enough to be one SSE frame. */
const CREATE_PROGRESS_MS = 2000;

/** Upper bound on a create request's prompt (chars). */
const MAX_CREATE_PROMPT = 4000;

/** The recipe a create request asks for: exactly the harness it named, or the
 *  registry default when it named none. The two are separate questions - a
 *  named harness that resolved to the default would author with a different
 *  agent than the caller asked for. */
const createRecipe = (
  registry: HarnessRegistry,
  harness?: string,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined =>
  harness === undefined ? defaultRecipe(registry) : resolveExactRecipe(registry, harness);

/** How long a proxied session's dedicated server has to ANSWER its event
 *  stream before the hub gives up and refuses the upgrade. Generous: the same
 *  server already answered an identity probe on a much tighter budget. */
const RELAY_OPEN_TIMEOUT_MS = 5000;

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
  /** How long a PROXIED session's dedicated server has to answer its event
   *  stream before the upgrade is refused (ms; tests). Injected so the stall
   *  case costs a test a moment rather than the production budget. */
  readonly relayOpenMs?: number;
  /** How often each mount's delivery watcher evaluates (ms; tests). */
  readonly attendPollMs?: number;
  /** Activity sink for attend-mode lines. Defaults to the rotating hub log
   *  mirrored to stdout (D-009), so a detached hub keeps its evidence. */
  readonly log?: (message: string) => void;
  /** Injected hub-log file path (tests). Default: `LUCID_HUB_LOG`, else
   *  `<home>/.lucid/hub.log`. Named for what it holds - `logPath` already
   *  means a session's review log everywhere else in this file. */
  readonly hubLogPath?: string;
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
  const relayOpenMs = opts.relayOpenMs ?? RELAY_OPEN_TIMEOUT_MS;
  const log = resolveHubSink(opts);
  // Every subsystem's narration goes where the hub's own evidence goes. A
  // stderr default is /dev/null here (the hub is normally started detached),
  // so `LUCID_VERBOSE=anchors` on a hub-hosted session produced nothing at all
  // while the contract told the reader where to look for it.
  const restoreNarration = setNarrationSink(log);
  warnUnknownSubsystems();

  /** Live create-turn heartbeats (M2.1), owned so `stop()` can end them: a
   *  detached child outlives the hub, and its interval would otherwise keep
   *  firing at nobody for the rest of that turn. */
  const heartbeats = new Set<ReturnType<typeof setInterval>>();
  /** The bound server, once it exists. Only the process that bound the port can
   *  upgrade a request to a WebSocket, and the routes that need to do so are
   *  defined before `Bun.serve` returns - so they read it through here. */
  let bound: ReturnType<typeof Bun.serve> | undefined;
  const upgrade: Upgrade = (req, socket) => bound?.upgrade(req, { data: socket }) === true;
  let port = 0; // assigned once bound (below)
  let stopped = false;
  let notifying = false;
  /** A change arrived while a notify pass was running; run one more after it. */
  let notifyAgain = false;
  let lastSnapshot = "";
  // Attention rides its OWN SSE event, deduped independently of the listing, so
  // an agent working (a `working` flip) never rebroadcasts the listing (R3,
  // D-016). The cache keeps an idle artifact at one stat per poll (M1.1).
  let lastAttentionSnapshot = "";

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

  /** A session's project, from the one owner of that question
   *  (`core/project.ts`): `project` is the grouping root - a worktree resolved
   *  to its main repo, a scratchpad decoded to the checkout it names - and
   *  `worktree` names the checkout when it differs. */
  const resolveProject = async (
    artifact: string,
  ): Promise<{ project: string; worktree?: string }> => {
    const cached = projectCache.get(artifact);
    if (cached !== undefined) return cached;
    const { project, worktree } = await projectOf(sessionPaths(artifact));
    const resolved = { project, ...(worktree !== undefined ? { worktree } : {}) };
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

  const computeListing = async (): Promise<HubSession[]> => {
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

  /**
   * The listing, served from the last answer while the next is computed
   * (`core/swr.ts` has the why).
   *
   * What the route awaiting this scan cost, specifically: a message POST hit
   * its 10s deadline and dropped into the composer's outbox, and
   * `/hub/identity` - which touches no disk at all - took 16s behind it.
   */
  const sessionListing = swr(computeListing, { minAgeMs: POLL_MS });

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
    const base = `/s/${id}`;
    const host = createSessionHost(paths, {
      getPort: () => port,
      base,
      // The mount's selection route validates against the SAME registry the
      // hub's create and attend paths use (tests inject their own).
      ...(opts.harnessesPath !== undefined ? { harnessesPath: opts.harnessesPath } : {}),
      onEnded: () => void evict(id),
      // Only the process that bound the port can upgrade, and every mount
      // shares this one. The socket's join closes over THIS host, so the
      // channel-agnostic handler needs to know nothing about mounts.
      upgrade,
    });
    const idleTimer = setInterval(
      () => {
        if (Date.now() - host.lastActivityAt() > sessionIdleMs) {
          void (async () => {
            // Same semantics as a dedicated server's idle-suspend: subscribers
            // learn of it, the log records it, memory is released. The log is
            // untouched otherwise - reopening refolds. A refused suspend means
            // a subscriber connected inside the check-to-append gap - the
            // session is live again, so it stays mounted.
            if (await host.suspend()) await evict(id);
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
          // So a turn this hub spawns opens its artifact back into THIS hub.
          hubPort: port,
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
    observation: RequestObservation,
  ): Promise<Response> => {
    observation.attach({ session: id });
    let artifact = idToArtifact.get(id);
    if (artifact === undefined) {
      // Unknown id: refresh the derived map once (a session opened after the
      // last listing), then give up. Through the listing rather than a walk of
      // its own - a shell restoring ten tabs against a hub that has just
      // restarted asks ten times at once, and ten independent walks of the
      // same tree (each rewriting the registry) is the pile-up single flight
      // exists to prevent. `computeListing` calls `rememberIds` on the way.
      await sessionListing.fresh();
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
        return artifactDocumentResponse(paths, `/s/${id}`, new URL(req.url).origin);
      }
      // ...and the review page, for exactly the same reason. Proxied, the
      // dedicated server renders it for base "" - so every URL on the page
      // addresses the HUB ROOT instead of this mount, and `/__lucid/state`
      // 404s into a review UI that loads and does nothing. Nobody sees an
      // error; the page is simply inert.
      //
      // That mattered little while this URL was only reachable by typing it.
      // The solo view (plan 06) hands it to a chat app's pane, where it is
      // held across reloads - and a session can legitimately end up on a
      // dedicated server later (the hub quit, an `open` ran, the hub came
      // back). The version comes off the live server's own identity, which the
      // handshake above already fetched.
      if (subPath === "/__lucid/viewer" && req.method === "GET") {
        return viewerResponse({
          session: paths.artifactPath,
          name: basename(paths.artifactPath),
          port,
          version: live.version,
          base: `/s/${id}`,
        });
      }
      const url = new URL(req.url);
      // A WebSocket handshake cannot be forwarded by fetch, and the window
      // asking for one is on the HUB's origin - which is where the
      // six-connection pool bites, so falling back to SSE would put the socket
      // right back. The hub takes the socket itself and relays the inner
      // server's SSE into it: browser side upgraded, loopback side unchanged.
      if (subPath === "/__lucid/events" && wantsUpgrade(req)) {
        // Subscribed BEFORE upgraded (see relayDedicated). The deadline covers
        // the HANDSHAKE only and is cleared once headers land - an SSE body is
        // meant to stay open, and a session with nothing happening is silent
        // for minutes at a time. Without it a dedicated server that answered
        // the identity probe and then stalled would hold this request forever,
        // and `loopbackFetch` imposes no deadline of its own.
        const ctl = new AbortController();
        const deadline = setTimeout(() => ctl.abort(), relayOpenMs);
        let stream: ReadableStream<Uint8Array> | null = null;
        try {
          const res = await loopbackFetch(live.port, `${subPath}${url.search}`, {
            signal: ctl.signal,
          });
          if (res.ok) stream = res.body;
        } catch {
          // refused, or took longer than the deadline
        } finally {
          clearTimeout(deadline);
        }
        // Refusing is the useful answer: the socket never opens, so the client
        // backs off and reconnects, and THAT reconnect re-runs the decision
        // above - by which time the dead server is usually gone and the hub
        // hosts the session itself.
        if (stream === null) {
          ctl.abort();
          return json({ error: "the session's server did not answer its stream" }, 502);
        }
        const body = stream;
        const upgraded = upgradeOrRefuse(req, upgrade, (sub) => relayDedicated(body, ctl, sub));
        if (!wasUpgraded(upgraded)) ctl.abort(); // nothing will ever read it now
        return upgraded;
      }
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

  /**
   * A listing frame for the shell windows.
   *
   * `after` is for a snapshot taken BECAUSE something changed - a session
   * opened, a root was added: a frame carrying the state before that change is
   * a shell told the news and shown the old world, and it costs the wait for
   * the walk in flight plus one more. Everything else - the poll tick, priming
   * a window that just connected - takes the cached listing, because nothing
   * happened just before it and a window that waited two walks to paint would
   * sit longer on "Looking for sessions…" than it ever did before this cache
   * existed.
   */
  const snapshot = async (mode: "cached" | "after-change" = "cached"): Promise<HubListing> => {
    // The bundle stamp rides every snapshot: the watcher's file mtime in dev
    // mode, the embedded build hash in production. Either way, when a shell
    // reconnects to a hub running NEWER UI than it is, the stamp differs and
    // the shell reloads itself - a hub restart updates live windows instead
    // of leaving them on the old bundle.
    const stamp = devBundleStamp() ?? CLIENT_BUNDLE_HASH;
    const sessions =
      mode === "after-change" ? await sessionListing.fresh() : await sessionListing.cached();
    return { sessions, bundle: stamp };
  };

  /**
   * Every shell window watching the listing, over either wire (live.ts owns
   * the set, both wires and the drop-on-throw rule).
   *
   * Priming is the join hook so a window that upgraded gets the same first two
   * frames a window that did not would get - a fresh shell paints the listing
   * and its working badges without waiting for the next poll to find a change.
   */
  const channel = createChannel<HubFrame>({
    onJoin: (_sub, _join, send) => {
      void (async () => {
        try {
          send({ event: DEFAULT_FRAME, data: await snapshot() });
          send({ event: "attention", data: attentionSnapshot() });
        } catch {
          // best-effort priming; the poll will catch up
        }
      })();
    },
  });

  /** Fan one frame out to every shell window. */
  const broadcast = channel.send;

  /** The attention map every known session keys by its id. A per-session log
   *  read is skipped by the shared fold cache when nothing changed, so an idle
   *  listing costs one `stat` per artifact. A session with no log yet is simply
   *  absent; any error (permission, corrupt committed line) is surfaced once
   *  rather than silently masquerading as "no log yet". */
  const attentionSnapshot = (): Record<string, HubAttention> => {
    const map: Record<string, HubAttention> = {};
    for (const [id, artifact] of idToArtifact) {
      try {
        const state = sessionStateSync(sessionPaths(artifact));
        if (state.status === "none") continue; // nothing opened here; no badge
        map[id] = attentionOf(state);
      } catch (err) {
        log(`[hub] attention read failed for ${artifact}: ${(err as Error).message}`);
        // The id has no attention this pass; the badge just clears.
      }
    }
    return map;
  };

  // Re-broadcast the current listing whenever it changes. Gated on having
  // subscribers so a quiet daemon does not re-scan the disk, and never tighter
  // than POLL_MS so there is no busy loop. `notifying` guards the whole pass -
  // both snapshots, the dedupe and the fan-out - where the listing's own single
  // flight guards only the scan inside it.
  //
  // A caller that has just CHANGED something passes "after-change", and that
  // pass is never simply dropped: on a slow machine the poll tick that is
  // already running holds a walk that predates the change, so returning here
  // would broadcast the old world and store it as `lastSnapshot` - the change
  // would then surface only when something else happened to move. It is queued
  // instead, and runs once the pass in flight is done.
  /**
   * A frame that says nothing except "this hub is still here".
   *
   * A window cannot tell a quiet hub from a dead one: a browser holds a
   * WebSocket to a process that no longer exists without ever firing `close`
   * (measured - a Bun client sees the close on the same restart, Chrome does
   * not), so a shell that waits for a close waits forever. It stops receiving
   * the listing, and it never learns a new build shipped - every rollout
   * lands on disk and reaches nobody's screen.
   *
   * So liveness is stated rather than inferred. The client treats silence
   * past a few of these as a dead socket and reconnects, which is the one
   * thing that does not depend on the network telling the truth.
   */
  const TICK_EVERY = Math.max(1, Math.round(10_000 / POLL_MS));
  let ticks = 0;

  const notify = async (mode: "cached" | "after-change" = "cached"): Promise<void> => {
    if (channel.size() === 0) return;
    ticks += 1;
    if (ticks % TICK_EVERY === 0) broadcast({ event: "tick", data: null });
    if (notifying) {
      if (mode === "after-change") notifyAgain = true;
      return;
    }
    notifying = true;
    try {
      // Listing and attention are deduped SEPARATELY: a `working` flip changes
      // only the attention snapshot, so the listing frame is not re-sent (R3).
      // Compared as their serialized form, which is what "the same news" means
      // for a frame - the objects are rebuilt every pass.
      const snap = await snapshot(mode);
      const snapJson = JSON.stringify(snap);
      if (snapJson !== lastSnapshot) {
        lastSnapshot = snapJson;
        broadcast({ event: DEFAULT_FRAME, data: snap });
      }
      const att = attentionSnapshot();
      const attJson = JSON.stringify(att);
      if (attJson !== lastAttentionSnapshot) {
        lastAttentionSnapshot = attJson;
        broadcast({ event: "attention", data: att });
      }
    } catch (err) {
      // A listing that throws must not take the hub down: every caller here
      // fires and forgets, so an escaping rejection is an unhandled one.
      log(`[hub] listing broadcast failed: ${(err as Error).message}`);
    } finally {
      notifying = false;
    }
    if (notifyAgain) {
      notifyAgain = false;
      await notify("after-change");
    }
  };

  /**
   * Pump an ALREADY-OPEN inner event stream into one upgraded shell window,
   * for a session the hub proxies rather than hosts.
   *
   * The stream is opened before the upgrade, not here, and that ordering is
   * load-bearing. A window treats its socket opening as "I am subscribed": it
   * bootstraps and flushes its outbox on that signal. Subscribing to the inner
   * server afterwards leaves a window in which a POST can land, be appended,
   * and be broadcast to nobody - the sender's own item vanishes from the queue
   * and does not reappear until some later event happens to trigger a refold.
   * Proxying the SSE stream directly never had that gap, because the response
   * headers only arrived once the inner subscription existed; opening first is
   * what restores it.
   *
   * When the inner stream ends the window is asked to come back rather than
   * retried here: its reconnect re-runs the proxy-or-mount decision. Retrying
   * in place would pin the window to a port whose server may have exited -
   * which is exactly when the hub should be hosting the session itself.
   */
  const relayDedicated = (
    body: ReadableStream<Uint8Array>,
    ctl: AbortController,
    sub: Subscriber,
  ): (() => void) => {
    void (async () => {
      try {
        await pumpSse(body, (event, data) => sub.send(event, data), ctl.signal);
      } catch {
        // dropped or aborted - being asked back is the answer to both
      }
      if (ctl.signal.aborted) return;
      try {
        sub.close();
      } catch {
        // the window went away first; nothing to ask
      }
    })();
    return () => ctl.abort();
  };

  /** `POST /hub/open {artifact}`: register + surface a session as a tab. The
   *  CLI has already run openSession (the lifecycle append is its job); the
   *  daemon records the pointer, resolves the mount id, and tells connected
   *  shells. It never spawns anything. */
  const handleHubOpen = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as HubOpenRequest | null;
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
    void notify("after-change");
    // Tell open shell windows to surface this session as a tab NOW. The CLI
    // reads `shells` to decide whether a window took it - if one did, it
    // skips the default browser entirely (opening in Arc next to a live
    // shell window was the bug).
    broadcast({ event: "open-tab", data: { id } });
    const opened: HubOpenResult = {
      ok: true,
      id,
      base: `/s/${id}`,
      shell: `http://127.0.0.1:${port}/?s=${id}`,
      shells: channel.size(),
    };
    return json(opened);
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
  const handleHubCreate = async (
    req: Request,
    observation: RequestObservation,
  ): Promise<Response> => {
    if (!attend) {
      return json({ error: "create requires the hub's attend mode (lucid hub --attend)" }, 403);
    }
    const body = (await req.json().catch(() => null)) as HubCreateRequest | null;
    const project = typeof body?.project === "string" ? body.project : "";
    const name = typeof body?.name === "string" ? body.name : "";
    // Attach the identifiers the moment they exist, so even a refused create
    // is a queryable record - identifiers, never the prompt (D-005). The
    // name only counts as an identifier once it LOOKS like one: a string
    // that fails CREATE_NAME is whatever the caller typed, which could be
    // content, so it stays out and the 400 speaks for it.
    // Only what has EARNED the name of an identifier. `artifact` is gated on
    // CREATE_NAME; `project` and `harness` are attached below, each after the
    // check that makes it real. Attaching them here put ~256 bytes of
    // arbitrary caller text into a retained record on every refused create -
    // the same D-005 hole the artifact gate already closed (07#12).
    observation.attach({
      ...(CREATE_NAME.test(name) ? { artifact: name } : {}),
    });
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

    // The project is validated FIRST, before the name and prompt refusals, so
    // that a refusal on any ground is still queryable by project - while an
    // unrooted one still never reaches a record (07#12). Validating in the
    // other order forced a choice between those two, and both are wanted.
    const rows = await sessionListing.cached();
    // A worktree is a listed root of its own, grouped under its main repo -
    // both are legitimate create targets; anything else is not a project the
    // hub knows about.
    // Compare CANONICAL paths (plan 05, M1.1): the listing reports a project by
    // its real path, and a caller - a dialog, a script, a human - may hand over
    // any spelling that reaches the same folder.
    const asked = canonicalArtifactPath(project);
    const known = rows.some(
      (s) =>
        s.project === project ||
        s.worktree === project ||
        canonicalArtifactPath(s.project) === asked ||
        (s.worktree !== undefined && canonicalArtifactPath(s.worktree) === asked),
    );
    // A folder the human ADDED is a project even before it holds anything.
    // Judging only by the listing meant a freshly added, empty folder could be
    // picked in the dialog and then refused as "unknown project" on submit -
    // the folder was registered for scanning but never became somewhere you
    // could author INTO, which is the same split that made adding one feel like
    // it had done nothing at all.
    const rooted =
      known || (await scanRootSet()).some((root) => canonicalArtifactPath(root) === asked);
    if (!rooted) return json({ error: "unknown project" }, 400);
    // Rooted, so it names a place this hub actually scans - an identifier now,
    // not whatever the caller typed.
    observation.attach({ project });

    // The harness earns its place the same way, and for the same reason: a
    // caller-supplied string is not an identifier until something recognises
    // it. Resolved early only to ATTACH - the full resolution below still
    // owns refusing an unknown one and building its argv.
    const earlyRegistry = await loadRegistry(opts.harnessesPath);
    const earlyRecipe = earlyRegistry ? createRecipe(earlyRegistry, harness) : undefined;
    if (earlyRecipe) observation.attach({ harness: earlyRecipe.name });

    if (!CREATE_NAME.test(name)) {
      return json({ error: "name must be a plain .html filename" }, 400);
    }
    if (prompt.trim().length === 0 || prompt.length > MAX_CREATE_PROMPT) {
      return json({ error: `prompt must be 1..${MAX_CREATE_PROMPT} characters` }, 400);
    }
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

    // Into the project's artifact folder, never its root (plan 05, M3.2): the
    // agent this spawns is told to `lucid open <artifact>`, and open refuses a
    // path outside `.lucid/`. Writing to the root made the whole create flow
    // dead-end on its own refusal.
    const artifact = join(project, ARTIFACT_DIR, name);
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
      // Exact: falling back to the default would silently author with a
      // different agent than the one asked for.
      const resolved = registry ? createRecipe(registry, harness) : undefined;
      if (!resolved) {
        return json({ error: `no spawn recipe for harness "${harness ?? "(default)"}"` }, 400);
      }

      const paths = sessionPaths(artifact);
      // The daemon retains the validation ladder (M5.3 checkbox 13): a pick
      // the recipe does not offer fails HERE, with the adapter's own words,
      // rather than as an agent turn that dies on an unknown flag.
      const selArgs = selection ? selectionArgs(resolved.name, resolved.recipe, selection) : [];
      if ("error" in selArgs) return json({ error: selArgs.error }, 400);
      // The artifact folder too: the agent writes the artifact itself, and it
      // cannot write into a `.lucid/` that does not exist yet.
      await mkdir(dirname(artifact), { recursive: true });
      await mkdir(paths.sessionDir, { recursive: true });
      // The pick STICKS to the artifact: every later unattended resume reads
      // this sidecar rather than re-deriving a model from the registry.
      // Written BEFORE planTurn so planTurn's applicableSelection reads it.
      if (selection) {
        await writeSelection(paths, { harness: resolved.name, ...selection });
      }
      log(`create ${name}: spawning "${resolved.name}" in ${project}`);

      // Route through planTurn (M5.3): the argv, identity strategy, turn id,
      // and launch id all come from the same planner every other turn uses.
      // createArtifactPrompt is the prompt source, passed to planTurn as-is.
      const planned = await planTurn({
        mode: "create",
        paths,
        harness: resolved.name,
        recipe: resolved.recipe,
        registryFile: opts.harnessesPath ?? harnessRegistryPath(),
        cwd: project,
        prompt: createArtifactPrompt(artifact, prompt, title || undefined),
      });
      if (planned.status === "refused") {
        return json({ error: planned.reason }, 400);
      }
      // Record a caller-assigned identity as pending BEFORE the turn runs
      // (replaces prepareSpawnIdentity.recordAssigned): a child that crashes
      // pre-open must still leave a resumable record.
      if (planned.sessionId !== undefined && planned.strategy !== undefined) {
        await recordPendingIdentity(paths, {
          harness: resolved.name,
          sessionId: planned.sessionId,
          sessionIdAuthority: "assigned",
          launchId: planned.launchId,
        });
      }

      // Answer immediately: authoring is a whole agent turn, and the artifact
      // surfaces as a tab on its own `lucid open`. The claim is held until the
      // turn ends, so a retry while it runs is refused rather than doubled.
      const outLog = paths.createLog;
      const startedAt = Date.now();
      // The turn's own phase one-liner (`lucid progress --label`, the same
      // channel a revise turn narrates through). Pre-open, `deliver` falls
      // back to a direct append, so the labels are already sitting in the
      // child's log - the heartbeat reads the newest one and carries it, and
      // the dialog stops being a bare clock.
      const lastPhaseLabel = async (): Promise<string | undefined> => {
        const { events } = await readEvents(paths.logPath).catch(() => ({ events: [] as const }));
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const e = events[i];
          if (e === undefined) return undefined;
          if (e.t !== "agent_ack") continue;
          // Owned by LAUNCH, not by native session id: a discovered harness
          // has no id until it announces one, so its progress correlates by
          // the launch (or the click's trace) the child exported - and a
          // leftover process from a deleted artifact of the same name still
          // cannot narrate this creation.
          const stamp = e.attendant;
          const owned =
            stamp?.launchId === planned.launchId ||
            (planned.sessionId !== undefined && stamp?.sessionId === planned.sessionId) ||
            (observation.trace !== undefined && stamp?.trace === observation.trace);
          if (!owned) continue;
          const label = e.progress?.label;
          if (label !== undefined) return label;
        }
        return undefined;
      };
      // `ended` gates the ASYNC gap: clearInterval cannot cancel a callback
      // whose log read is already in flight, and a late frame after
      // `create-failed` would put the dead turn back into "authoring" in the
      // dialog forever (noteCreateProgress clears a failure by design).
      // `reading` keeps the 2s beats from stacking reads on a slow disk -
      // an older read finishing last must not regress the displayed label.
      let ended = false;
      let reading = false;
      const heartbeat = setInterval(() => {
        if (reading) return;
        reading = true;
        void (async () => {
          try {
            const label = await lastPhaseLabel();
            if (ended) return;
            broadcast({
              event: "create-progress",
              data: {
                artifact,
                trace: observation.trace,
                elapsedMs: Date.now() - startedAt,
                ...(label !== undefined ? { label } : {}),
              },
            });
          } finally {
            reading = false;
          }
        })();
      }, CREATE_PROGRESS_MS);
      // A heartbeat must never hold the process open.
      heartbeat.unref?.();
      heartbeats.add(heartbeat);

      // runTurn (M5.3) handles the spawn, out-log window, identity, failure
      // classification, and agent_turn_ended delivery. The daemon owns only
      // the SSE layer (heartbeat + create-failed broadcast) and the claim set.
      const broadcastFailure = (outcome: TurnOutcome): void => {
        const tail = outcome.output.trim().split("\n").slice(-3).join("\n").slice(-500);
        broadcast({
          event: "create-failed",
          data: {
            artifact,
            code: outcome.code,
            tail,
            ...(outcome.failure?.usageLimit != null
              ? { usageLimit: outcome.failure.usageLimit }
              : {}),
            ...(outcome.failure?.authFailure != null
              ? { authFailure: outcome.failure.authFailure }
              : {}),
          },
        });
      };

      void runTurn(planned, {
        outLog,
        requestId: observation.trace,
        hubPort: port,
        ...(planned.model !== undefined ? { model: planned.model } : {}),
        ...(planned.effort !== undefined ? { effort: planned.effort } : {}),
      })
        .then((outcome) => {
          if (outcome.code !== 0) {
            log(`create ${name}: create turn exited ${outcome.code}`);
            broadcastFailure(outcome);
          } else if (outcome.result.status === "identity-missing") {
            log(`create ${name}: turn announced no session identity (HSI002)`);
          }
        })
        .catch((err) => {
          log(`create ${name}: create turn failed: ${(err as Error).message}`);
          broadcast({
            event: "create-failed",
            data: { artifact, code: "spawn-error", tail: "" },
          });
        })
        .finally(() => {
          ended = true;
          clearInterval(heartbeat);
          heartbeats.delete(heartbeat);
          creating.delete(artifact);
        });
      handedOff = true;

      const accepted: HubCreateAccepted = { ok: true, artifact };
      return json(accepted, 202);
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
          res: json({ error: "no folder chooser on this platform" }, 501),
        };
      }
      // AppleScript returns an alias; POSIX path makes it a real path. A
      // cancel exits non-zero, which is not an error to report - the human
      // simply changed their mind.
      //
      // The chooser runs in osascript's OWN process, activated by `me`. Routing
      // it through `tell application "System Events"` made the dialog System
      // Events' to display, which costs an Automation (TCC) grant this process
      // may not hold and several seconds before anything appears - and when the
      // grant is missing the button looks like it does nothing at all. Nothing
      // here needs System Events: `activate` on `me` brings osascript forward,
      // which is the only reason it was involved.
      const proc = Bun.spawn(
        [
          "osascript",
          "-e",
          "tell me to activate",
          "-e",
          `set picked to choose folder with prompt "${prompt}"`,
          "-e",
          "POSIX path of picked",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      // A chooser nobody can see must not hold the request open forever: the
      // browser is waiting on this fetch, and a spinner with no dialog behind
      // it is the worst of both. Generous, because a human browsing folders is
      // slow on purpose - this is a hang guard, not an interaction budget.
      const timer = setTimeout(() => proc.kill(), CHOOSER_TIMEOUT_MS);
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      clearTimeout(timer);
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
    const body = (await req.json().catch(() => null)) as HubRootsRequest | null;
    const chosen = await chooseFolder(
      body as Record<string, unknown> | null,
      "Choose a folder to scan for Lucid sessions",
    );
    if ("res" in chosen) return chosen.res;
    await addRoot(chosen.dir, rootsPath);
    // The listing's cached answer was computed for the OLD root set, so it is
    // not stale here - it is wrong. Drop it: the next reader waits for a scan
    // that includes what they just added, which is the whole point of adding it.
    sessionListing.invalidate();
    // Counted from a scan of JUST this folder - `listAll` would union the
    // registry and report sessions that have nothing to do with the pick.
    // The count is what tells the human they picked the right folder, so it is
    // worth waiting a moment for - but only a moment. Scanning a home
    // directory was measured at ~16s, and the root is already persisted before
    // it starts, so a client that gave up reported failure for an add that had
    // in fact succeeded, and the human re-added a folder the hub already had
    // (07#14). The count is not what makes the add real; the persist is, and
    // the sessions themselves arrive on the listing stream regardless.
    const scan = scanRoots([chosen.dir]).catch(() => []);
    const counted = await Promise.race([
      scan.then((found) => found.length),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), ROOT_COUNT_BUDGET_MS)),
    ]);
    // Either way the sessions arrive on the listing stream, which every window
    // reads - so a slow scan costs the count, never the add.
    void scan.then(() => notify("after-change"));
    // The EFFECTIVE set, not just the persisted additions: this is what the
    // shell displays as "looking in", and answering with the additions alone
    // made it forget the defaults (`~/dev`, the scratchpads) it still scans.
    const added: HubRootsResponse = {
      root: chosen.dir,
      roots: await scanRootSet(),
      ...(counted !== undefined ? { found: counted } : {}),
    };
    return json(added, 200, noStore);
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
    // Naming a project REGISTERS it. This route used to resolve a path and
    // return it, persisting nothing - so the folder existed only in the
    // dialog's React state, and `/hub/create` (which validates against real
    // projects) refused it as unknown the moment you pressed the button.
    //
    // That was the architecture failing rather than a missing check: "project"
    // was a value DERIVED per session from its artifact's path, so a project
    // holding no sessions had nowhere to exist. The scan roots are the one
    // place a project can be recorded before it holds anything, so naming one
    // writes there - the same store the folder chooser on the roots route uses.
    await addRoot(proj.project, rootsPath);
    // Same mutation as the roots route: the cached listing was computed for a
    // root set that did not include this folder, so it is wrong rather than
    // merely old.
    sessionListing.invalidate();
    void notify("after-change");
    return json(
      {
        project: proj.project,
        ...(proj.worktree ? { worktree: proj.worktree } : {}),
        chosen: dir,
        roots: await scanRootSet(),
      },
      200,
      noStore,
    );
  };

  const handle = async (req: Request, observation: RequestObservation): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

    const sessionMatch = /^\/s\/([a-f0-9]{16})(\/.*)?$/.exec(pathname);

    // The overlay bundle is the ONE pre-gate route (the sandboxed artifact
    // iframe loads it from an opaque origin). It is the same static bytes
    // for every session, so it is served here at the router - reaching it
    // must never resolve ids, scan the registry, or mount anything.
    if (sessionMatch && sessionMatch[2] === "/__lucid/client.js") {
      return serveBundleAsset("client.js", req);
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
      return handleSessionRoute(req, sessionMatch[1], sessionMatch[2] || "/", observation);
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
      const identity: HubIdentity = {
        lucid: "hub",
        port,
        shells: channel.size(),
        attend,
        roots: await scanRootSet(),
        harnesses,
        harnessInfo,
        ...(registry?.default !== undefined ? { defaultHarness: registry.default } : {}),
        // The debug surface (M1.1 observability): the shared session-state
        // fold cache's hit/miss/entries, readable with
        // `curl <hub>/hub/identity`.
        debug: { sessionStateCache: sessionStateCacheStats() },
        // The hub's OWN view of its log (M3.2). `lucid status` runs in a
        // different process and can resolve a different LUCID_HUB_LOG - or
        // miss an explicitly injected path entirely - so asking beats
        // re-deriving: the writer is the only process that knows where its
        // evidence actually goes.
        log: sinkStatus(opts.hubLogPath),
      };
      return json(identity, 200, noStore);
    }
    if (pathname === "/hub/sessions" && req.method === "GET") {
      // `?fresh=1` is for a caller that has just been told something changed
      // and is looking for the row that proves it - the shell's `open-tab`
      // handler. Everyone else takes the cached answer and never waits on I/O.
      const sessions = await (url.searchParams.get("fresh") === "1"
        ? sessionListing.fresh()
        : sessionListing.cached());
      const listing: HubSessionsResponse = { sessions };
      return json(listing, 200, noStore);
    }
    if (pathname === "/hub/open" && req.method === "POST") {
      return handleHubOpen(req);
    }
    if (pathname === "/hub/create" && req.method === "POST") {
      return handleHubCreate(req, observation);
    }
    if (pathname === "/hub/project" && req.method === "POST") {
      return handleHubProject(req);
    }
    if (pathname === "/hub/roots" && req.method === "POST") {
      return handleHubRoots(req);
    }
    if (pathname === "/hub/events" && req.method === "GET") {
      // A shell window upgrades; anything else still gets SSE. The Host/Origin
      // gate above has already run, which matters MORE here: a WebSocket
      // handshake is not subject to CORS at all.
      return wantsUpgrade(req) ? channel.handleUpgrade(req, upgrade) : channel.sseResponse();
    }
    // The shell's own bundle + stylesheet, same generated artifacts every
    // session mount serves - the chrome is one bundle in two modes.
    if (pathname === "/__lucid/chrome.js") return serveBundleAsset("chrome.js", req);
    if (pathname === "/__lucid/chrome.css") return serveBundleAsset("chrome.css", req);
    if (pathname === "/favicon.ico") return serveBundleAsset("favicon.ico", req);
    if (pathname === "/") return shellResponse();
    return json({ error: "not found" }, 404);
  };

  // One requested port, so a busy one is a failure rather than a slide onto
  // another: a hub is found by its port. Binding through the shared owner also
  // means that failure now leaves as a typed `ServerError` (SERVER_ERROR),
  // where the bare `Bun.serve` let a raw `EADDRINUSE` out - the dedicated
  // server's behaviour, and the documented closed set of error codes.
  const server = serveLoopback({
    ports: [requestedPort],
    name: "daemon",
    handler: handle,
    sink: log,
  });
  bound = server;
  port = server.port ?? 0;

  // The one line that matters most to a detached hub - which port it actually
  // bound - through the sink, so it lands in the file and not only on the
  // stdout that self.ts discards (D-009).
  log(
    `lucid hub listening on http://127.0.0.1:${port}${attend ? " (attend mode: headless turns enabled)" : ""}`,
  );

  const timer = setInterval(() => void notify(), POLL_MS);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    restoreNarration();
    clearInterval(timer);
    for (const beat of heartbeats) clearInterval(beat);
    heartbeats.clear();
    // Before the eviction loop, not after: the guard that turns joins away
    // lives in the channel now, and evicting mounts awaits. A window landing
    // inside that await would otherwise be taken on and PRIMED - a listing
    // walk plus an attention fold per session - against a hub that is going
    // away. Nothing broadcasts during eviction, so closing first costs the
    // windows still here nothing; the server closing them itself is what is
    // unsafe (RECONNECT_FRAME), and `stop` does not do that.
    channel.stop();
    for (const id of [...mounts.keys()]) await evict(id);
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

/** What a live hub reports about itself, as the CLI uses it: the slice of
 *  `HubIdentity` (protocol/hub.ts) the terminal has decisions to make about,
 *  with `port` being the one that ANSWERED rather than the one it claims. */
export interface HubInfo {
  readonly port: number;
  /** Connected shell windows (listing-stream subscribers). */
  readonly shells: number;
  /** True when the hub runs the attend engine (headless turns + create). */
  readonly attend: boolean;
  /** The hub's own view of where its evidence goes, and whether it is landing
   *  (M3.2). Absent from an older hub, which is why the reader falls back. */
  readonly log?: SinkStatus;
}

/** The hub's identity on `port`, or undefined when none answers. */
export const hubInfo = async (port = HUB_PORT): Promise<HubInfo | undefined> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HUB_PROBE_TIMEOUT_MS);
    const probe = await loopbackFetch(port, "/hub/identity", {
      signal: controller.signal,
      // The probe rides the same trace as the open it fronts - without this,
      // every `lucid open` emits one un-joined record right before the
      // joined one.
      headers: { [REQUEST_ID_HEADER]: cliRequestId() },
    });
    clearTimeout(timer);
    if (!probe.ok) return undefined;
    // The identity contract (protocol/hub.ts), read defensively: whatever
    // answers this port may be older than these fields, or not a hub at all.
    const who = (await probe.json()) as Partial<HubIdentity>;
    if (who.lucid !== "hub") return undefined;
    // The hub's own log view rides along when it reports one; an older hub
    // reports none and the caller falls back to deriving its own.
    const log = typeof who.log?.path === "string" ? who.log : undefined;
    return {
      port,
      shells: typeof who.shells === "number" ? who.shells : 0,
      attend: who.attend === true,
      ...(log ? { log } : {}),
    };
  } catch {
    return undefined;
  }
};

/** True when a hub daemon answers its identity probe on `port`. */
export const hubAlive = async (port = HUB_PORT): Promise<boolean> =>
  (await hubInfo(port)) !== undefined;

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
      headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: cliRequestId() },
      body: JSON.stringify({ artifact }),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as HubOpenResult;
  } catch {
    return undefined;
  }
};
