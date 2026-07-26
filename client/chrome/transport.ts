/**
 * The session-scoped HTTP surface. Every request a session makes goes through
 * its own transport, bound to that session's URL base - "" under a per-session
 * server, "/s/<id>" once the daemon hosts many sessions on one origin. Nothing
 * in the chrome may fetch a control route with a bare absolute path, or it
 * would read another session's data the moment two share an origin.
 */

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
    const attempts = isPost ? 4 : 1;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${base}${path}`, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) return res;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
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
    const res = await fetch(`${base}/__lucid/asset`, {
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
