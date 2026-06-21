import { readFile, rm, writeFile } from "node:fs/promises";
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
}

export const writeServerDescriptor = async (
  paths: SessionPaths,
  descriptor: ServerDescriptor,
): Promise<void> => {
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
}

const HANDSHAKE_TIMEOUT_MS = 800;

/**
 * Handshake the recorded port. Returns the identity if a live Lucid server for
 * THIS session answers, else undefined. Matching on the session path guards
 * against a different process having taken the port.
 */
export const handshake = async (
  port: number,
  expectedSession: string,
): Promise<IdentityResponse | undefined> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/identity`, {
      signal: controller.signal,
      headers: { host: `127.0.0.1:${port}` },
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = (await res.json()) as IdentityResponse;
    if (body.lucid === true && body.session === expectedSession) return body;
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
  return handshake(descriptor.port, paths.artifactPath);
};
