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

/** The session's mount id when a server mounted it, else null. An
 *  unrecognised base means this server did not mount the session, so there is
 *  no prefix to carry - never string-concatenated into a URL. */
const mountIdOf = (identity: IdentityResponse): string | null =>
  /^\/s\/([a-f0-9]+)$/.exec(identity.base ?? "")?.[1] ?? null;

/**
 * The URL a human opens for a live session in the SHELL. A dedicated server
 * has its own viewer page; a hub-mounted session (base "/s/<id>") is a TAB -
 * `<hub>/?s=<id>` - because `<hub>/s/<id>/__lucid/viewer` would render a
 * second chrome inside the one window.
 *
 * That rejection is scoped to the shell, and `soloViewerUrl` below returns
 * exactly the URL rejected here (plan 06, D-013). The nesting hazard belongs
 * to the SURFACE, not to the URL: an embedded pane in a chat app has no outer
 * chrome to nest inside, and the chat app itself plays the shell's role there.
 * Read unscoped, this comment makes the sibling look like a mistake to delete.
 */
export const viewerUrl = (identity: IdentityResponse): string => {
  const mountId = mountIdOf(identity);
  return mountId
    ? `http://127.0.0.1:${identity.port}/?s=${mountId}`
    : `http://127.0.0.1:${identity.port}/__lucid/viewer`;
};

/**
 * The same session's review UI with NO shell around it (plan 06, M1.2) - what
 * a chat desktop app's embedded pane shows.
 *
 * No new route: `/__lucid/viewer` already serves the review UI, and the daemon
 * routes `/s/<id>/*` into the same session-host body, so a hub-hosted session
 * already has a shell-free URL. This only selects it. The mount prefix is
 * carried, or the hub answers for a different session - or for none.
 */
export const soloViewerUrl = (identity: IdentityResponse): string => {
  const mountId = mountIdOf(identity);
  const base = mountId ? `/s/${mountId}` : "";
  return `http://127.0.0.1:${identity.port}${base}/__lucid/viewer`;
};
