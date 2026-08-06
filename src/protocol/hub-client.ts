import { hubPort, portBase } from "../core/ports.ts";
import { mintRequestId, REQUEST_ID_HEADER, WELL_FORMED_ID } from "../core/request-id.ts";
import type { HubIdentity, HubOpenResult, SinkStatus } from "./hub.ts";

/**
 * The loopback probe owner (M3.5, D-009): every fetch to a Lucid server on
 * `127.0.0.1` - the discovery handshake, the CLI's hub `identity`/`open`
 * probes, the delivery and wait seams - goes through ONE function that stamps
 * the request-id trace, sets the loopback Host, and (for the hub probes) holds
 * a deadline and decodes JSON with `catch -> undefined`.
 *
 * Lives in `protocol/` (the shared contract home, importable by both bundles)
 * rather than `server/`, so the CLI's `run.ts` reaches the hub probe without
 * importing the daemon. It imports nothing from `server/` - only the pure
 * `ports` and `request-id` core leaves and the hub wire types.
 */

/** The CLI's own request id: the one a `lucid` invocation is already stamped
 *  with (LUCID_REQUEST_ID), minted otherwise. Moved here from server/observe
 *  so the probe can stamp the same trace without a server-tier import. */
export const cliRequestId = (env: NodeJS.ProcessEnv = process.env): string => {
  const held = env.LUCID_REQUEST_ID;
  return held !== undefined && WELL_FORMED_ID.test(held) ? held : mintRequestId();
};

/**
 * Fetch a loopback URL on `127.0.0.1:<port>`, stamping the request-id trace
 * (adopting a well-formed carried id, minting otherwise) and the loopback Host.
 * The one function every server-bound hop goes through, so the trace that joins
 * a request to the click that caused it cannot be forgotten by a new call site.
 */
export const loopbackFetch = (
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  // Headers() normalizes every HeadersInit form, so a caller passing a Headers
  // instance or an entries array is not silently dropped by an object spread.
  const headers = new Headers(init.headers);
  headers.set("host", `127.0.0.1:${port}`);
  const carried = headers.get(REQUEST_ID_HEADER);
  if (carried === null || !WELL_FORMED_ID.test(carried)) {
    headers.set(REQUEST_ID_HEADER, cliRequestId());
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
};

/** The hub's default port: the configured base applied to the port ladder. */
export const HUB_PORT = hubPort(portBase(process.env));

/** Parse a `LUCID_HUB_PORT` override: a whole port number in range. */
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
  /** The hub's own view of where its evidence goes. Absent from an older hub. */
  readonly log?: SinkStatus;
}

const HUB_PROBE_TIMEOUT_MS = 500;

/**
 * Probe a hub daemon's `/hub/identity`: a deadline-bounded loopback fetch that
 * decodes the identity contract defensively and returns `undefined` on any
 * failure (no hub, a non-hub server, a timeout, a bad decode). The probe rides
 * the same trace as the open it fronts.
 */
export const hubInfo = async (port = HUB_PORT): Promise<HubInfo | undefined> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HUB_PROBE_TIMEOUT_MS);
    const probe = await loopbackFetch(port, "/hub/identity", {
      signal: controller.signal,
      headers: { [REQUEST_ID_HEADER]: cliRequestId() },
    });
    clearTimeout(timer);
    if (!probe.ok) return undefined;
    const who = (await probe.json()) as Partial<HubIdentity>;
    if (who.lucid !== "hub") return undefined;
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
 * dedicated per-session server, so a machine without the shell keeps the exact
 * pre-daemon behavior.
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
