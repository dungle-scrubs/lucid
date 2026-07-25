import type { SessionPaths } from "../core/paths.ts";
import { ServerError } from "../errors.ts";
import { removeServerDescriptor, writeServerDescriptor } from "./discovery.ts";
import { createSessionHost } from "./session-host.ts";

export interface ServerOptions {
  /** Idle window before auto-suspend (ms). 0 disables auto-suspend. */
  readonly idleMs?: number;
  /** Watcher debounce (ms). */
  readonly debounceMs?: number;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * Preferred per-session ports, tried in order before falling back to `0`
 * (ephemeral). A stable port keeps a reopened session on the URL the browser
 * already has; the trailing `0` guarantees a session still starts when every
 * preferred port is taken.
 */
export const PORT_POOL: readonly number[] = [
  17412, 17413, 17414, 17415, 17416, 17417, 17418, 17419, 0,
];

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

  const host = createSessionHost(paths, {
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    getPort: () => port,
    onEnded: () => void stop(),
  });

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
            return await host.handle(req);
          } catch (err) {
            return new Response(
              JSON.stringify({ error: `server error: ${(err as Error).message}` }),
              { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
            );
          }
        },
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!server) {
    host.stop();
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

  // ---- idle suspend ----------------------------------------------------------
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  if (idleMs > 0) {
    idleTimer = setInterval(
      () => {
        if (Date.now() - host.lastActivityAt() > idleMs && !stopped) {
          void (async () => {
            // Suspend appends + broadcasts BEFORE stop() closes the streams,
            // so subscribers learn of it.
            await host.suspend();
            await stop();
          })();
        }
      },
      Math.min(idleMs, 5000),
    );
  }

  return done;
};
