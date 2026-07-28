import { dirname } from "node:path";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import type { SessionPaths } from "../core/paths.ts";

/**
 * Per-session server discovery (D-036) and handshake liveness (D-049). There is
 * no global registry; each session advertises its runtime via `server.json`,
 * and liveness is verified by a loopback handshake to the recorded port - NOT
 * by pid existence, because a reused pid is a false-positive that would block
 * `wait` forever.
 */

export interface ServerDescriptor {
  readonly port: number;
  readonly pid: number;
  readonly session: string;
  readonly startedAt: string;
  /** URL prefix of the session's routes on that server: absent/"" on a
   *  dedicated per-session server, "/s/<id>" when the hub daemon hosts it.
   *  Every out-of-process caller must prepend it. */
  readonly base?: string;
}

/**
 * Fetch a per-session server route over loopback. Owns the one request shape
 * every out-of-process caller must use: the explicit Host header is what lets
 * the request through the server's DNS-rebind gate (`validateHeaders`).
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
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
};

export const writeServerDescriptor = async (
  paths: SessionPaths,
  descriptor: ServerDescriptor,
): Promise<void> => {
  // server.json is machine-local, under run/ (plan 02); a mount may write it
  // before ensureSessionDirs has created run/, so mkdir defensively.
  await mkdir(dirname(paths.serverJson), { recursive: true });
  await writeFile(paths.serverJson, `${JSON.stringify(descriptor, null, 2)}\n`);
};

export const readServerDescriptor = async (
  paths: SessionPaths,
): Promise<ServerDescriptor | undefined> => {
  try {
    const raw = await readFile(paths.serverJson, "utf8");
    return JSON.parse(raw) as ServerDescriptor;
  } catch {
    return undefined;
  }
};

export const removeServerDescriptor = async (paths: SessionPaths): Promise<void> => {
  await rm(paths.serverJson, { force: true });
};

export interface IdentityResponse {
  readonly lucid: true;
  readonly session: string;
  readonly port: number;
  readonly version: number;
  /** The session's route prefix on the answering server ("" when absent).
   *  Carried from the descriptor so callers address `${base}/__lucid/...`. */
  readonly base?: string;
}

const HANDSHAKE_TIMEOUT_MS = 800;

/**
 * Handshake the recorded port. Returns the identity if a live Lucid server for
 * THIS session answers, else undefined. Matching on the session path guards
 * against a different process having taken the port. `base` scopes the probe
 * to the session's mount on a shared server (the hub daemon).
 */
export const handshake = async (
  port: number,
  expectedSession: string,
  base = "",
): Promise<IdentityResponse | undefined> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    const res = await loopbackFetch(port, `${base}/__lucid/identity`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = (await res.json()) as IdentityResponse;
    if (body.lucid === true && body.session === expectedSession) return { ...body, base };
    return undefined;
  } catch {
    return undefined;
  }
};

/** Discover a live server for the session, or undefined if none is live. */
export const discoverLiveServer = async (
  paths: SessionPaths,
): Promise<IdentityResponse | undefined> => {
  const descriptor = await readServerDescriptor(paths);
  if (!descriptor) return undefined;
  return handshake(descriptor.port, paths.artifactPath, descriptor.base ?? "");
};

/**
 * The URL a human opens for a live session. A dedicated server has its own
 * viewer page; a hub-mounted session (base "/s/<id>") is a TAB in the shell -
 * `<hub>/?s=<id>` - because `<hub>/s/<id>/__lucid/viewer` would render a
 * second chrome inside the one window.
 */
export const viewerUrl = (identity: IdentityResponse): string => {
  const base = identity.base ?? "";
  const mountId = /^\/s\/([a-f0-9]+)$/.exec(base)?.[1];
  return mountId
    ? `http://127.0.0.1:${identity.port}/?s=${mountId}`
    : `http://127.0.0.1:${identity.port}/__lucid/viewer`;
};
