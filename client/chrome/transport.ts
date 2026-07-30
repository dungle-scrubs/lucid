/**
 * The session-scoped HTTP surface. Every request a session makes goes through
 * its own transport, bound to that session's URL base - "" under a per-session
 * server, "/s/<id>" once the daemon hosts many sessions on one origin. Nothing
 * in the chrome may fetch a control route with a bare absolute path, or it
 * would read another session's data the moment two share an origin.
 */

import { hubFetch } from "./request.ts";

/** What `POST <base>/__lucid/asset` returns: the server-decided identity of a
 *  stored blob. */
export interface UploadedAsset {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

export interface Transport {
  /** URL prefix for every route of this session ("" or "/s/<id>"). */
  readonly base: string;
  /** GET (no body) or POST (JSON body) a control route, with retry on POST. */
  readonly api: (path: string, body?: unknown) => Promise<Response>;
  /** Upload a blob to the session's pasted store. Throws on failure so each
   *  caller keeps its own recovery. */
  readonly uploadAsset: (file: File) => Promise<UploadedAsset>;
  /** The URL an already-stored pasted image is served from. */
  readonly assetUrl: (file: string) => string;
}

/**
 * Every request gets a deadline. Without one a socket that accepts and then
 * never answers - a hub caught mid-restart - leaves the await pending forever,
 * and any flag the caller set around it is stuck on: `sending` stayed true,
 * which disabled the composer, which made Enter insert a newline instead of
 * sending. A hang must become a failed attempt so the retry can run and the
 * caller can keep the human's text and say so.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A POST waits far longer than a GET, and retries over a much wider window.
 *
 * Appends serialize on one lock per artifact. An agent rewriting a 100KB
 * artifact holds it for seconds at a time, and the old schedule (4 attempts
 * inside 1.2s, 15s each) put every attempt in the SAME burst - so a human
 * message was refused outright while the agent worked, which is the wrong way
 * round: the person is waiting at the keyboard, the agent is not.
 */
const POST_TIMEOUT_MS = 30_000;
const POST_BACKOFF_MS = [500, 1500, 4000, 8000];

export const createTransport = (base: string): Transport => {
  const api = async (path: string, body?: unknown): Promise<Response> => {
    const isPost = body !== undefined;
    const init: RequestInit = {
      method: isPost ? "POST" : "GET",
      ...(isPost
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    };
    // POSTs retry with backoff so a brief server blip (e.g. a restart) doesn't
    // lose the submission - every mutation carries a client-minted idempotent
    // id, so a retry of one that landed is safe. A persistent failure throws so
    // the caller can keep the human's input and surface an error.
    const attempts = isPost ? POST_BACKOFF_MS.length + 1 : 1;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await hubFetch(`${base}${path}`, {
          ...init,
          signal: AbortSignal.timeout(isPost ? POST_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
        });
        if (res.ok) return res;
        // The body carries the server's own reason ("the log is busy"), which
        // is the difference between a message a human can act on and "it
        // didn't send".
        const detail = await res
          .clone()
          .json()
          .then((b: unknown) =>
            b !== null &&
            typeof b === "object" &&
            typeof (b as { error?: unknown }).error === "string"
              ? ` - ${(b as { error: string }).error}`
              : "",
          )
          .catch(() => "");
        lastErr = new Error(`HTTP ${res.status}${detail}`);
        // A 4xx is the server's VERDICT, not a hiccup: this address belongs to
        // another session (409), the body is malformed (400). Retrying it just
        // spends the human's patience to be told the same thing five times.
        if (res.status >= 400 && res.status < 500) throw lastErr;
      } catch (e) {
        if (e === lastErr) throw e;
        lastErr = e;
      }
      const backoff = POST_BACKOFF_MS[i];
      if (i < attempts - 1 && backoff !== undefined) {
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new Error(`request to ${base}${path} failed`);
  };

  /**
   * The one implementation of the upload protocol (content-type +
   * x-lucid-filename headers, raw body) - the annotation composer and the
   * message composer both route through it. The bytes must land before the
   * event referencing them does, because the agent reads them off disk.
   */
  const uploadAsset = async (file: File): Promise<UploadedAsset> => {
    const res = await hubFetch(`${base}/__lucid/asset`, {
      method: "POST",
      headers: { "content-type": file.type, "x-lucid-filename": file.name || "pasted" },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    return (await res.json()) as UploadedAsset;
  };

  return {
    base,
    api,
    uploadAsset,
    assetUrl: (file: string) => `${base}/__lucid/asset/${file}`,
  };
};
