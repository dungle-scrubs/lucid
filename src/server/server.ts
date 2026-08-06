import type { SessionPaths } from "../core/paths.ts";
import { removeServerDescriptor, writeServerDescriptor } from "./discovery.ts";
import { createLogSink } from "./observe.ts";
import { serveLoopback } from "./live.ts";
import { portBase, sessionPortPool } from "./ports.ts";
import { createSessionHost } from "./session-host.ts";

export interface ServerOptions {
  /** Idle window before auto-suspend (ms). 0 disables auto-suspend. */
  readonly idleMs?: number;
  /** Watcher debounce (ms). */
  readonly debounceMs?: number;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * Preferred per-session ports for THIS process, offset by `LUCID_PORT_BASE`.
 *
 * The numbers and the reasoning behind them live in `ports.ts`; this is the
 * binding of them to the current environment. Machine-global by default, which
 * is right for one human on one machine and wrong for four test workers - see
 * that module.
 */
export const PORT_POOL: readonly number[] = sessionPortPool(portBase(process.env));

/**
 * Run the dedicated per-session loopback server (the long-lived daemon body).
 * A thin owner around ONE SessionHost (session-host.ts): it binds a port from
 * the pool, writes the discovery descriptor, and applies the idle-suspend
 * policy; every route, append, broadcast and watcher belongs to the host. It
 * is the sole appender during the active session (browser POSTs and CLI
 * control writes route through it, serialized via the log lock). Resolves
 * when the session is ended or auto-suspended.
 */
export const runServer = async (
  paths: SessionPaths,
  requestedPorts: readonly number[],
  options: ServerOptions = {},
): Promise<void> => {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  let port = 0; // assigned once the server binds (below)
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearInterval(idleTimer);
    host.stop();
    await removeServerDescriptor(paths);
    boundServer.stop(true);
    resolveDone();
  };

  // Only the process that BOUND the port can upgrade a request, and that is
  // this owner, not the host. Read through a binding assigned below, because
  // the host is constructed before the server exists.
  let bound: ReturnType<typeof Bun.serve> | undefined;

  const host = createSessionHost(paths, {
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    getPort: () => port,
    onEnded: () => void stop(),
    upgrade: (req, socket) => bound?.upgrade(req, { data: socket }) === true,
  });

  // This server's OWN boundary record (plan 08 M10). Two things the first
  // attempt got wrong, both caught in review:
  //
  // The SINK is per-session, not the shared hub log. N dedicated servers
  // writing to one file interleave records of identical shape, into a file
  // whose rotation this repo already documents as lossy - and the default sink
  // also mirrors to stdout, which spawnServer redirects to a file the codebase
  // itself calls uncapped, so every request would grow it forever.
  //
  // And every record carries the session, attached here rather than per route:
  // a dedicated server serves exactly ONE artifact, so its identity is a
  // property of the server, not of the request. Without it the records were
  // anonymous - a record is defined as carrying which artifact it is about.
  let boundServer: ReturnType<typeof Bun.serve>;
  try {
    boundServer = serveLoopback({
      ports: requestedPorts,
      name: "server",
      sink: createLogSink({ path: paths.requestLog, mirror: () => {} }),
      handler: async (req, observation) => {
        // Attached here, not per route: a dedicated server serves exactly ONE
        // artifact, so its identity is a property of the server.
        observation.attach({ artifact: paths.artifactPath });
        return host.handle(req, undefined, observation);
      },
    });
  } catch (err) {
    host.stop();
    throw err;
  }
  bound = boundServer;
  port = boundServer.port ?? 0;

  // One line naming what was bound and why it was available.
  //
  // The offset is derived silently from the environment, so a collision between
  // two parallel workers surfaces as a session that never answers - a hung
  // server, to anyone reading the log - rather than as two processes wanting
  // one number. This is the only place that knows both, and the per-session
  // server is where a collision would actually happen: the stamp cannot say it,
  // because it runs outside every worker and always sees base 0.
  console.log(
    `lucid session server on 127.0.0.1:${port} ` +
      `(base ${portBase(process.env)}, pool [${requestedPorts.join(", ")}])`,
  );

  await writeServerDescriptor(paths, {
    port,
    pid: process.pid,
    session: paths.artifactPath,
    startedAt: new Date().toISOString(),
  });

  // ---- idle suspend ----------------------------------------------------------
  // The policy is the host's (M3.2): one poll/suspend/onSuspended shape,
  // shared with the hub's mounts. The server passes its `!stopped` flag as
  // the gate so a stopping server never suspends, and `stop` as the action.
  const idleTimer = host.startIdlePolicy(
    idleMs,
    // Suspend appends + broadcasts BEFORE stop() closes the streams, so
    // subscribers learn of it. Refused = a subscriber connected in the gap;
    // the server stays up for them.
    () => stop(),
    () => !stopped,
  );

  return done;
};
