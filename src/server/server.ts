import { statSync, mkdirSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseAnchor } from "../anchors/anchor.ts";
import { readLastAttendant } from "../core/attendant.ts";
import { diffHtml } from "../diff/diff.ts";
import { foldLog, versionRef } from "../core/fold.ts";
import type { EventInput, LogEvent, PromptImage } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { listSessions, projectRoot } from "../core/sessions.ts";
import { ServerError } from "../errors.ts";
import { assemblePayload } from "../core/payload.ts";
import { commitWatchedChange } from "../core/session.ts";
import type { SessionsResponse, StateResponse } from "../protocol/wire.ts";
import {
  CHROME_BUNDLE,
  CHROME_CSS,
  CLIENT_BUNDLE,
  FAVICON_SVG,
} from "./client-bundle.generated.ts";
import { removeServerDescriptor, writeServerDescriptor } from "./discovery.ts";
import { injectOverlay } from "./inject.ts";
import { resolveAsset, validateHeaders } from "./security.ts";
import { renderViewer } from "./viewer.ts";

export interface ServerOptions {
  /** Idle window before auto-suspend (ms). 0 disables auto-suspend. */
  readonly idleMs?: number;
  /** Watcher debounce (ms). */
  readonly debounceMs?: number;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 150;

/** Accepted pasted-image content types -> extension. */
const IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};
const ASSET_CONTENT_TYPE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** Validate a browser-supplied pasted-image manifest. */
const parseImages = (input: unknown): PromptImage[] => {
  if (!Array.isArray(input)) return [];
  const out: PromptImage[] = [];
  for (const item of input) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as PromptImage).id === "string" &&
      typeof (item as PromptImage).name === "string" &&
      typeof (item as PromptImage).file === "string" &&
      /^[a-f0-9-]+\.[a-z]+$/i.test((item as PromptImage).file)
    ) {
      const it = item as PromptImage;
      out.push({ id: it.id, name: it.name.slice(0, 120), file: it.file });
    }
  }
  return out;
};

/** Paths the browser/crawler requests on its own (not referenced by the
 *  artifact). They are answered without a missing-asset warning. */
const BROWSER_PROBES = new Set([
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/robots.txt",
]);

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const noStore = { "cache-control": "no-store" } as const;

/**
 * Cheap `stat` fingerprint (size + mtimeMs) for the polling watcher. Returns
 * null if the artifact is not statable. Used to gate the 1Hz poll so a quiet
 * session does not re-read + hash the artifact every second.
 */
const statFingerprint = (absPath: string): string | null => {
  try {
    const s = statSync(absPath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};

/**
 * Run the per-session loopback server (the long-lived daemon body). It is the
 * sole appender during the active session: browser POSTs and CLI control
 * writes route through `serverAppend`, which serializes via the log lock and
 * broadcasts to SSE subscribers. Resolves when the session is ended or
 * auto-suspended.
 */
/**
 * Preferred per-session ports, tried in order before falling back to `0`
 * (ephemeral). A stable port keeps a reopened session on the URL the browser
 * already has; the trailing `0` guarantees a session still starts when every
 * preferred port is taken.
 */
export const PORT_POOL: readonly number[] = [
  17412, 17413, 17414, 17415, 17416, 17417, 17418, 17419, 0,
];

export const runServer = async (
  paths: SessionPaths,
  requestedPorts: readonly number[],
  options: ServerOptions = {},
): Promise<void> => {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  /** Which subscribers are agents blocked in `wait` (their waker connects with
   *  ?role=agent). Presence for the viewer: "is anyone listening right now". */
  const agentClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let port = 0; // assigned once the server binds (below)
  let stopped = false;
  let lastActivity = Date.now();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const touch = (): void => {
    lastActivity = Date.now();
  };

  const broadcastRaw = (chunk: Uint8Array): void => {
    for (const client of sseClients) {
      try {
        client.enqueue(chunk);
      } catch {
        sseClients.delete(client);
        if (agentClients.delete(client)) queueMicrotask(broadcastListeners);
      }
    }
  };

  const broadcast = (event: LogEvent): void => {
    broadcastRaw(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  /** Synthetic frame (like `warning`): the count of agents currently blocked
   *  in wait. Sent whenever it changes, so the composer can say "listening". */
  const broadcastListeners = (): void => {
    broadcastRaw(
      encoder.encode(
        `event: listeners\ndata: ${JSON.stringify({ agents: agentClients.size })}\n\n`,
      ),
    );
  };

  const serverAppend = async (inputs: readonly EventInput[]): Promise<readonly LogEvent[]> => {
    const events = await appendEvents(paths.logPath, inputs);
    for (const e of events) broadcast(e);
    touch();
    return events;
  };

  const currentVersion = async (): Promise<number> => {
    const state = foldLog((await readEvents(paths.logPath)).events);
    return state.version;
  };

  // ---- request handling -----------------------------------------------------

  const handleEvents = (isAgent: boolean): Response => {
    // Assigned synchronously in `start` before any frame is enqueued; the `!`
    // marks that definite assignment for the `cancel` reader below.
    let self!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        sseClients.add(controller);
        if (isAgent) {
          agentClients.add(controller);
          broadcastListeners();
        }
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        sseClients.delete(self);
        if (agentClients.delete(self)) broadcastListeners();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  };

  const handleAnnotation = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.note !== "string") {
      return json({ error: "invalid annotation" }, 400);
    }
    const anchor = parseAnchor(body.target);
    if ("error" in anchor) return json({ error: anchor.error }, 400);
    const version =
      typeof body.version === "number" && Number.isInteger(body.version) ? body.version : 0;
    // Same validator as a message's images: an annotation's images are the same
    // pasted blobs, just located.
    const images = parseImages(body.images);
    // Client-supplied authorship time, display metadata only (seq stays the
    // cursor). Bounded sanity check rather than trust: a parseable timestamp.
    const authoredAt =
      typeof body.authoredAt === "string" &&
      body.authoredAt.length <= 40 &&
      !Number.isNaN(Date.parse(body.authoredAt))
        ? body.authoredAt
        : undefined;
    await serverAppend([
      {
        t: "annotation",
        id: body.id,
        version,
        target: anchor,
        note: body.note,
        ...(authoredAt ? { authoredAt } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
    ]);
    return json({ ok: true });
  };

  const handleMessage = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.text !== "string") {
      return json({ error: "invalid message" }, 400);
    }
    const refs = Array.isArray(body.refs)
      ? body.refs.filter((r): r is string => typeof r === "string")
      : [];
    const images = parseImages(body.images);
    if (body.text.trim() === "" && images.length === 0) {
      return json({ error: "empty message" }, 400);
    }
    await serverAppend([
      { t: "prompt", id: body.id, refs, text: body.text, ...(images.length > 0 ? { images } : {}) },
    ]);
    return json({ ok: true });
  };

  const handleAssetUpload = async (req: Request): Promise<Response> => {
    const contentType = req.headers.get("content-type") ?? "application/octet-stream";
    if (!contentType.startsWith("image/")) {
      return json({ error: "only image uploads are accepted" }, 400);
    }
    const ext = IMAGE_EXT[contentType.split(";")[0] ?? ""] ?? "bin";
    const name = (req.headers.get("x-lucid-filename") ?? "pasted").slice(0, 120);
    const id = crypto.randomUUID();
    const file = `${id}.${ext}`;
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) {
      return json({ error: "image is empty or too large" }, 400);
    }
    mkdirSync(paths.pastedDir, { recursive: true });
    await Bun.write(join(paths.pastedDir, file), bytes);
    touch();
    return json({ id, name, file });
  };

  const handleQuestion = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.id !== "string" ||
      typeof body.text !== "string" ||
      body.text.trim() === ""
    ) {
      return json({ error: "invalid question" }, 400);
    }
    await serverAppend([
      {
        t: "question",
        id: body.id,
        text: body.text,
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
      },
    ]);
    return json({ ok: true });
  };

  const handleAnswer = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.id !== "string" ||
      typeof body.questionId !== "string" ||
      typeof body.text !== "string" ||
      body.text.trim() === ""
    ) {
      return json({ error: "invalid answer" }, 400);
    }
    await serverAppend([
      { t: "question_answered", id: body.id, questionId: body.questionId, text: body.text },
    ]);
    return json({ ok: true });
  };

  const handleRevert = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.id !== "string" ||
      typeof body.why !== "string" ||
      typeof body.targetVersion !== "number"
    ) {
      return json({ error: "invalid revert" }, 400);
    }
    const anchor = parseAnchor(body.target);
    if ("error" in anchor) return json({ error: anchor.error }, 400);
    await serverAppend([
      {
        t: "revert",
        id: body.id,
        target: anchor,
        targetVersion: Math.trunc(body.targetVersion),
        why: body.why,
      },
    ]);
    return json({ ok: true });
  };

  /** Diff the current artifact against a base version (RFC §8). */
  const handleDiff = async (url: URL): Promise<Response> => {
    const state = foldLog((await readEvents(paths.logPath)).events);
    const baseVersion = Number.parseInt(url.searchParams.get("base") ?? "", 10);
    const ref = versionRef(state, Number.isFinite(baseVersion) ? baseVersion : state.version - 1);
    const currentHtml = await readFile(paths.currentHtml, "utf8").catch(() => "");
    if (!ref || !Number.isFinite(baseVersion) || baseVersion >= state.version) {
      return json({
        base: baseVersion,
        current: state.version,
        changed: false,
        hunks: [],
        mergedHtml: "",
      });
    }
    const baseHtml = await readFile(join(paths.sessionDir, ref.path), "utf8").catch(() => "");
    return json(diffHtml(baseHtml, currentHtml, ref.version, state.version));
  };

  const handleAck = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string") return json({ error: "invalid ack" }, 400);
    const intent = body.intent === "revise" || body.intent === "reply" ? body.intent : undefined;
    await serverAppend([{ t: "agent_ack", id: body.id, ...(intent ? { intent } : {}) }]);
    return json({ ok: true });
  };

  const handleReply = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.text !== "string") {
      return json({ error: "invalid reply" }, 400);
    }
    await serverAppend([{ t: "agent_reply", id: body.id, text: body.text }]);
    return json({ ok: true });
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (watcher) watcher.close();
    if (idleTimer) clearInterval(idleTimer);
    clearInterval(pollTimer);
    for (const client of sseClients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    sseClients.clear();
    await removeServerDescriptor(paths);
    boundServer.stop(true);
    resolveDone();
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

    // The overlay bootstrap bundle is a public static asset. It must be
    // reachable from the sandboxed artifact iframe, which loads it cross-origin
    // (opaque origin -> Origin: null). Serving it BEFORE the Host/Origin gate
    // (with a CORS allow) lets the overlay mount; the control routes below still
    // reject null/cross-origin callers, so artifact scripts cannot reach them.
    if (pathname === "/__lucid/client.js") {
      const headers: Record<string, string> = {
        "content-type": "text/javascript; charset=utf-8",
        "access-control-allow-origin": req.headers.get("origin") ?? "*",
        "access-control-allow-credentials": "true",
        ...noStore,
      };
      if (req.headers.get("origin") !== null) headers.vary = "Origin";
      return new Response(CLIENT_BUNDLE, { headers });
    }

    const headerCheck = validateHeaders(req, port);
    if (!headerCheck.ok) {
      return json({ error: `forbidden: ${headerCheck.reason}` }, 403);
    }
    touch();

    // ---- control routes (reserved prefix) ----
    if (pathname === "/__lucid/identity") {
      return json({
        lucid: true,
        session: paths.artifactPath,
        port,
        version: await currentVersion(),
      });
    }
    if (pathname === "/__lucid/viewer") {
      return new Response(
        renderViewer({
          session: paths.artifactPath,
          name: basename(paths.artifactPath),
          port,
          version: await currentVersion(),
        }),
        { headers: { "content-type": "text/html; charset=utf-8", ...noStore } },
      );
    }
    // The chrome's own bundle + stylesheet. Unlike the overlay these stay
    // behind the Host/Origin gate: they are same-origin requests from Lucid's
    // viewer page, and nothing in the sandboxed artifact should reach them.
    if (pathname === "/__lucid/chrome.js") {
      return new Response(CHROME_BUNDLE, {
        headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/chrome.css") {
      return new Response(CHROME_CSS, {
        headers: { "content-type": "text/css; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/events") {
      return handleEvents(url.searchParams.get("role") === "agent");
    }
    if (pathname === "/__lucid/artifact") {
      const html = await readFile(paths.currentHtml, "utf8").catch(() => "");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/state") {
      const state = foldLog((await readEvents(paths.logPath)).events);
      const payload = await assemblePayload(
        paths,
        state,
        state.status === "ended"
          ? "ended"
          : state.status === "suspended"
            ? "suspended"
            : "feedback",
        {
          annotations: state.annotations,
          messages: state.messages,
          reverts: state.reverts,
        },
      );
      // Who last took delivery, from the advisory sidecars: display data for
      // the chrome's resume affordance, never something the server executes.
      const attendant = await readLastAttendant(paths);
      const response: StateResponse = {
        ...payload,
        agentsListening: agentClients.size,
        ...(attendant
          ? {
              lastAttendant: {
                harness: attendant.harness,
                at: attendant.at,
                ...(attendant.resume ? { resume: attendant.resume } : {}),
              },
            }
          : {}),
      };
      return json(response);
    }
    if (pathname === "/__lucid/sessions" && req.method === "GET") {
      const root = await projectRoot(paths);
      const response: SessionsResponse = {
        root,
        current: paths.artifactPath,
        sessions: await listSessions(root),
      };
      return json(response, 200, noStore);
    }
    if (pathname === "/__lucid/diff") return handleDiff(url);
    if (pathname === "/__lucid/annotation" && req.method === "POST") return handleAnnotation(req);
    if (pathname === "/__lucid/message" && req.method === "POST") return handleMessage(req);
    if (pathname === "/__lucid/revert" && req.method === "POST") return handleRevert(req);
    if (pathname === "/__lucid/question" && req.method === "POST") return handleQuestion(req);
    if (pathname === "/__lucid/answer" && req.method === "POST") return handleAnswer(req);
    if (pathname === "/__lucid/asset" && req.method === "POST") return handleAssetUpload(req);
    if (pathname.startsWith("/__lucid/asset/")) {
      const file = pathname.slice("/__lucid/asset/".length);
      if (!/^[a-f0-9-]+\.[a-z]+$/i.test(file)) return json({ error: "bad asset" }, 400);
      const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
      const f = Bun.file(join(paths.pastedDir, file));
      if (!(await f.exists())) return json({ error: "not found" }, 404);
      return new Response(f, {
        headers: { "content-type": ASSET_CONTENT_TYPE[ext] ?? "application/octet-stream" },
      });
    }
    if (pathname === "/__lucid/reply" && req.method === "POST") return handleReply(req);
    if (pathname === "/__lucid/ack" && req.method === "POST") return handleAck(req);
    if (pathname === "/__lucid/resolve" && req.method === "POST") {
      await serverAppend([{ t: "review_resolved" }]);
      return json({ ok: true });
    }
    if (pathname === "/__lucid/reopen" && req.method === "POST") {
      await serverAppend([{ t: "review_reopened" }]);
      return json({ ok: true });
    }
    if (pathname === "/__lucid/end" && req.method === "POST") {
      await serverAppend([{ t: "session_ended" }]);
      queueMicrotask(() => void stop());
      return json({ ok: true });
    }

    // ---- browser auto-probes: serve the viewer's own icon, never warn ----
    // These are requested by the browser/crawler, not referenced by the
    // artifact, so a 404 here is not a missing artifact asset (no warning).
    if (pathname === "/favicon.ico") {
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" },
      });
    }
    if (BROWSER_PROBES.has(pathname)) {
      return new Response(null, { status: 204 });
    }

    // ---- artifact document route (fixed; D-054) ----
    if (pathname === "/") {
      const html = await readFile(paths.currentHtml, "utf8").catch(() => null);
      if (html === null) return json({ error: "artifact not available" }, 404);
      return new Response(injectOverlay(html), {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      });
    }

    // ---- static asset route ----
    const resolved = resolveAsset(pathname, paths.artifactDir);
    if (!resolved.ok) {
      broadcastWarning(resolved.warning.code, resolved.warning.message);
      return json({ error: resolved.warning.message }, resolved.status);
    }
    const file = Bun.file(resolved.absPath);
    if (!(await file.exists())) {
      broadcastWarning("ASSET_NOT_FOUND", `asset not found: ${pathname}`);
      return json({ error: "not found" }, 404);
    }
    return new Response(file, { headers: { "content-type": resolved.contentType } });
  };

  // Surface denied/missing assets to subscribers as a synthetic event so the
  // chrome can show them (D-054). Encoded as an agent-less warning frame.
  const broadcastWarning = (code: string, message: string): void => {
    const chunk = encoder.encode(`event: warning\ndata: ${JSON.stringify({ code, message })}\n\n`);
    for (const client of sseClients) {
      try {
        client.enqueue(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

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
            return await handle(req);
          } catch (err) {
            return json({ error: `server error: ${(err as Error).message}` }, 500);
          }
        },
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!server) {
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

  // ---- artifact change detection --------------------------------------------
  // commitNow() is driven by BOTH fs.watch and a polling fallback: fs.watch is
  // not guaranteed (Node documents this) and is unreliable through a symlinked
  // path (e.g. macOS /tmp -> /private/tmp) or across atomic-rename saves, so a
  // 1s hash poll guarantees a settled change is committed regardless.
  const artifactBase = basename(paths.artifactPath);
  let committing = false;
  const commitNow = async (): Promise<void> => {
    if (committing) return;
    committing = true;
    try {
      const result = await commitWatchedChange(paths);
      if (result.committed) {
        // Broadcast the actually-appended event (real seq/timestamp), not a
        // synthetic stand-in, so the SSE stream stays consistent with the log.
        broadcast(result.committed);
      } else if (result.warning) {
        broadcastWarning(result.warning.code, result.warning.message);
      }
    } catch {
      // transient; the poll will retry
    } finally {
      committing = false;
    }
  };

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onChange = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void commitNow(), debounceMs);
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(paths.artifactDir, (_event, filename) => {
      if (!filename || filename === artifactBase) onChange();
    });
  } catch {
    watcher = undefined;
  }
  // Polling fallback (see above): catches anything fs.watch misses. To avoid
  // re-reading + hashing the artifact every second on a quiet session, the poll
  // is gated on a cheap stat (size + mtimeMs); it only commits when those move.
  let lastStat = statFingerprint(paths.artifactPath);
  const pollTimer = setInterval(() => {
    const next = statFingerprint(paths.artifactPath);
    if (next !== null && next !== lastStat) {
      lastStat = next;
      void commitNow();
    } else if (next !== null) {
      // unchanged; keep the baseline current
      lastStat = next;
    }
  }, 1000);

  // ---- idle suspend ----------------------------------------------------------
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  if (idleMs > 0) {
    idleTimer = setInterval(
      () => {
        if (Date.now() - lastActivity > idleMs && !stopped) {
          void (async () => {
            // Route through serverAppend so subscribers learn of the suspend
            // before stop() closes the streams.
            await serverAppend([{ t: "session_suspended" }]);
            await stop();
          })();
        }
      },
      Math.min(idleMs, 5000),
    );
  }

  return done;
};
