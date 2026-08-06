import type { SessionPaths } from "../core/paths.ts";
import { removeServerDescriptor, writeServerDescriptor } from "./discovery.ts";
import { createLogSink } from "./observe.ts";
import { serveLoopback, type LoopbackServer } from "./live.ts";
import { portBase, sessionPortPool } from "../core/ports.ts";
import { createSessionHost, type SessionHost } from "./session-host.ts";

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
    host?.stop();
    await removeServerDescriptor(paths);
    server.stop(true);
    resolveDone();
  };

  // The host/router is built INSIDE serveLoopback's handler factory (M2.3):
  // serveLoopback binds the port, then hands the factory {port, upgrade} so the
  // host gets the WebSocket upgrade fn directly - no caller-side let-bound
  // server. The host is captured here for the idle policy and shutdown.
  let host: SessionHost | undefined;
  // This server's OWN boundary record (plan 08 M10): the SINK is per-session
  // (N dedicated servers writing to one shared log interleave), and every
  // record carries the session, attached in the factory rather than per route
  // (a dedicated server serves exactly ONE artifact).
  let server: LoopbackServer;
  try {
    server = serveLoopback({
      ports: requestedPorts,
      name: "server",
      sink: createLogSink({ path: paths.requestLog, mirror: () => {} }),
      handler: ({ port: boundPort, upgrade }) => {
        const h = createSessionHost(paths, {
          ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
          getPort: () => boundPort,
          onEnded: () => void stop(),
          upgrade,
        });
        host = h;
        return {
          attach: (observation) => observation.attach({ artifact: paths.artifactPath }),
          gate: h.gate,
          route: (req, observation) => h.handle(req, undefined, observation),
        };
      },
    });
  } catch (err) {
    host?.stop();
    throw err;
  }
  const boundHost = host as SessionHost;
  port = server.port;

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
  const idleTimer = boundHost.startIdlePolicy(
    idleMs,
    // Suspend appends + broadcasts BEFORE stop() closes the streams, so
    // subscribers learn of it. Refused = a subscriber connected in the gap;
    // the server stays up for them.
    () => stop(),
    () => !stopped,
  );

  return done;
};
