/**
 * The hub's session mount lifecycle (M5.4): mount, evict, stopAll.
 *
 * Extracted from daemon.ts so the mount Map, idle policy, descriptor
 * ownership, and attend wiring are one module's concern. The daemon provides
 * factory callbacks (createSessionHost, createAttendant, discoverLiveServer)
 * and runtime state (port, stopped) as getters.
 *
 * The routing logic (handleSessionRoute: proxy vs host vs stale-descriptor)
 * stays in the daemon - it needs the listing and response helpers that are
 * not mount concerns.
 */
import type { Upgrade } from "./live.ts";
import { type Attendant, createAttendant } from "./attend.ts";
import type { SessionPaths } from "../core/paths.ts";
import { createSessionHost, type SessionHost } from "./session-host.ts";
import {
  discoverLiveServer,
  readServerDescriptor,
  removeServerDescriptor,
  writeServerDescriptor,
} from "./discovery.ts";

/** A hosted session's internal record: its host, timers, and optional attend
 *  watcher. Closed over by the module - never returned to the daemon, which
 *  reaches a mount only through its `handle` (M3.2 narrowing). */
interface HostedSession {
  readonly paths: SessionPaths;
  readonly host: SessionHost;
  readonly idleTimer?: ReturnType<typeof setInterval>;
  readonly attendant?: Attendant;
  readonly attendTimer?: ReturnType<typeof setInterval>;
}

/** A hosted session's single outward surface: route a request to its host. The
 *  daemon cannot reach a mount's timers, paths, or attendant - only forward a
 *  request - so a mount's lifecycle is the module's alone (M3.2). */
export interface Mount {
  readonly handle: SessionHost["handle"];
}

export interface MountsOptions {
  readonly log: (line: string) => void;
  /** The daemon's bound port (0 before bind). */
  readonly port: () => number;
  /** Whether the daemon is shutting down. */
  readonly stopped: () => boolean;
  readonly sessionPaths: (artifact: string) => SessionPaths;
  readonly upgrade: Upgrade;
  readonly sessionIdleMs: number;
  readonly attend: boolean;
  readonly attendPollMs: number;
  readonly harnessesPath?: string;
  readonly attendDebounceMs?: number;
}

export interface Mounts {
  /** Host a session in-process (idempotent). Returns undefined when a
   *  dedicated server owns the session (caller proxies). */
  mount: (id: string, artifact: string) => Promise<Mount | undefined>;
  /** Unmount a hosted session: close streams/watchers, release descriptor. */
  evict: (id: string) => Promise<void>;
  /** Evict all mounts (shutdown). */
  stopAll: () => Promise<void>;
  /** Whether a session is currently hosted. */
  has: (id: string) => boolean;
  /** Get a hosted session's mount, or undefined. */
  get: (id: string) => Mount | undefined;
  /** Whether no session is currently hosted. */
  isEmpty: () => boolean;
}

/** Create the mounts module (M5.4). The mount Map, idle policy, descriptor
 *  ownership, and attend wiring live here; the daemon provides factories and
 *  runtime state. */
export const createMounts = (opts: MountsOptions): Mounts => {
  const mounts = new Map<string, HostedSession>();
  const port = opts.port;
  const pid = process.pid;

  const evict = async (id: string): Promise<void> => {
    const mount = mounts.get(id);
    if (!mount) return;
    opts.log(`[hub] session ${id}: evicting (${mount.paths.artifactPath})`);
    mounts.delete(id);
    if (mount.idleTimer) clearInterval(mount.idleTimer);
    if (mount.attendTimer) clearInterval(mount.attendTimer);
    mount.attendant?.stop();
    mount.host.stop();
    const desc = await readServerDescriptor(mount.paths);
    if (desc && desc.pid === pid) await removeServerDescriptor(mount.paths);
  };

  const mount = async (id: string, artifact: string): Promise<Mount | undefined> => {
    if (opts.stopped()) throw new Error("daemon is stopping");
    const live = await discoverLiveServer(opts.sessionPaths(artifact));
    if (live && live.port !== port()) {
      opts.log(`[hub] session ${id}: proxied to dedicated server on port ${live.port}`);
      return undefined;
    }
    opts.log(`[hub] session ${id}: hosting ${artifact}`);
    const existing = mounts.get(id);
    if (existing) return { handle: existing.host.handle };
    const paths = opts.sessionPaths(artifact);
    const base = `/s/${id}`;
    const host = createSessionHost(paths, {
      getPort: () => port(),
      base,
      ...(opts.harnessesPath !== undefined ? { harnessesPath: opts.harnessesPath } : {}),
      onEnded: () => void evict(id),
      upgrade: opts.upgrade,
    });
    // The hub's mount idle policy is the host's (M3.2): an unconditional mount
    // has no stopped-gate (it always checks idle), and evicts on suspend.
    const idleTimer = host.startIdlePolicy(opts.sessionIdleMs, () => evict(id));
    const attendant = opts.attend
      ? createAttendant({
          paths,
          agentsListening: () => host.agentsListening(),
          warn: (code, message) => host.warn(code, message),
          ...(opts.harnessesPath !== undefined ? { harnessesPath: opts.harnessesPath } : {}),
          ...(opts.attendDebounceMs !== undefined ? { debounceMs: opts.attendDebounceMs } : {}),
          hubPort: port(),
          log: opts.log,
        })
      : undefined;
    if (attendant) void attendant.tick();
    const attendTimer = attendant
      ? setInterval(() => void attendant.tick(), opts.attendPollMs)
      : undefined;
    const created: HostedSession = {
      paths,
      host,
      idleTimer,
      ...(attendant ? { attendant } : {}),
      ...(attendTimer ? { attendTimer } : {}),
    };
    // A mount is visible to routing ONLY after its descriptor write succeeds
    // (M0.1): inserting before the write left a window onto a host whose
    // descriptor write then rolled back, so a concurrent route could reach a
    // mount the next boot's stale-descriptor guard would later reject.
    try {
      await writeServerDescriptor(paths, {
        port: port(),
        pid,
        session: paths.artifactPath,
        startedAt: new Date().toISOString(),
        base,
      });
    } catch (err) {
      clearInterval(idleTimer);
      if (attendTimer) clearInterval(attendTimer);
      attendant?.stop();
      host.stop();
      throw err;
    }
    mounts.set(id, created);
    return { handle: created.host.handle };
  };

  const stopAll = async (): Promise<void> => {
    for (const id of [...mounts.keys()]) await evict(id);
  };

  return {
    mount,
    evict,
    stopAll,
    has: (id) => mounts.has(id),
    get: (id) => {
      const rec = mounts.get(id);
      return rec ? { handle: rec.host.handle } : undefined;
    },
    isEmpty: () => mounts.size === 0,
  };
};
