import { statSync, mkdirSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { basename, join } from "node:path";
import { parseAnchor, type Anchor } from "../anchors/anchor.ts";
import { harnessSessionId, interactiveResumeCommand, presenceFor } from "../core/presence.ts";
import { readSettingsCached } from "../core/settings.ts";
import { artifactAttendant, readLastAttendant } from "../core/attendant.ts";
import { readContextSidecar, sanitizeContext, writeContextSidecar } from "../core/context.ts";
import { diffHtml } from "../diff/diff.ts";
import { foldLog, versionRef } from "../core/fold.ts";
import {
  sanitizeAttendant,
  TURN_END_CODE,
  TURN_END_REASONS,
  type TurnEndReason,
} from "../core/events.ts";
import {
  legacyProjection,
  normalizeItemAnswers,
  normalizeQuestionGroup,
  projectLegacyAnswer,
  summarizeAnswer,
  validateAnswer,
  validateGroup,
} from "../core/question-contract.ts";
import type { AttendantStamp, EventInput, LogEvent, PromptImage } from "../core/events.ts";
import { appendEvents, appendEventsIf, readEvents } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { listSessions, projectRoot } from "../core/sessions.ts";
import { assemblePayload } from "../core/payload.ts";
import {
  atomicWrite,
  commitAgainstSnapshot,
  commitWatchedChange,
  readArtifact,
} from "../core/session.ts";
import { escapeHtml } from "../core/escape.ts";
import {
  loadRegistry,
  normalizeHarness,
  resolveRecipe,
  type SpawnRecipe,
} from "../launch/recipes.ts";
import {
  readSelection,
  sanitizeSelection,
  selectionArgs,
  writeSelection,
} from "../launch/selection.ts";
import type {
  ContextUsage,
  SelectionResponse,
  SessionsResponse,
  StateResponse,
} from "../protocol/wire.ts";
import { sanitizeProgress } from "../core/progress.ts";
import {
  CHROME_BUNDLE,
  CHROME_CSS,
  CLIENT_BUNDLE,
  FAVICON_SVG,
} from "./client-bundle.generated.ts";
import { readDevAsset } from "./dev-assets.ts";
import { renderInjected } from "./inject.ts";
import {
  LiveSocket,
  sseSubscriber,
  UPGRADED,
  wantsUpgrade,
  type Subscriber,
  type Upgrade,
} from "./live.ts";
import { resolveAsset, validateHeaders } from "./security.ts";
import { renderViewer, sseMaxBackoffFromEnv } from "./viewer.ts";

/**
 * One session's complete server behavior - routes, event fan-out, artifact
 * change detection - detached from any particular socket. The dedicated
 * per-session server (server.ts) binds a port and mounts ONE host at "/";
 * the always-on daemon (daemon.ts) mounts many, each under "/s/<id>". The
 * host never owns the socket, the descriptor file, or the idle policy: those
 * belong to the owner, which is what makes the same body serve both process
 * models (Model B, Phase 2).
 */

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

/** A multi-anchor list is bounded so a runaway client cannot flood the log
 *  with one POST; the chrome caps collection at the same number. */
const MAX_ANCHORS = 8;

/**
 * Validate an optional multi-anchor list (`targets` on an annotation,
 * `anchors` on an answer). Every element goes through parseAnchor and ONE
 * invalid element rejects the whole POST - a half-valid list would store a
 * note claiming spots it does not have. Returns undefined when the field is
 * absent or empty, so callers fall back to the single-anchor form.
 */
const parseAnchorList = (
  input: unknown,
  field: string,
): Anchor[] | { readonly error: string } | undefined => {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return { error: `${field} must be an array` };
  if (input.length === 0) return undefined;
  if (input.length > MAX_ANCHORS) return { error: `too many ${field} (max ${MAX_ANCHORS})` };
  const out: Anchor[] = [];
  for (const item of input) {
    const anchor = parseAnchor(item);
    if ("error" in anchor) return { error: `${field}[${out.length}]: ${anchor.error}` };
    out.push(anchor);
  }
  return out;
};

/** Validate an untrusted attendant provenance stamp (D18): the shared
 *  normalizer bounds and control-strips it - a malformed stamp is dropped,
 *  never trusted. */
const parseAttendant = (input: unknown): AttendantStamp | undefined => sanitizeAttendant(input);

/** Validate an untrusted structured-question `options` array into clean
 *  choices, dropping any without a non-empty string label. */
const parseQuestionOptions = (input: unknown): { label: string; description?: string }[] => {
  if (!Array.isArray(input)) return [];
  const out: { label: string; description?: string }[] = [];
  for (const item of input) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.label === "string" && o.label.trim().length > 0) {
        out.push({
          label: o.label.trim(),
          ...(typeof o.description === "string" && o.description.length > 0
            ? { description: o.description }
            : {}),
        });
      }
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

export interface SessionHostOptions {
  /** Watcher debounce (ms). */
  readonly debounceMs?: number;
  /** The owner's bound port, for the Host/Origin gate and identity. Read
   *  lazily because Bun assigns it after construction begins. */
  readonly getPort: () => number;
  /** URL prefix this session is mounted under: "" on a dedicated server,
   *  "/s/<id>" under the daemon. Baked into the viewer page it serves so the
   *  chrome addresses THIS session's routes. */
  readonly base?: string;
  /** Harness registry file backing the selection route (tests inject; default
   *  is recipes.ts's own resolution). */
  readonly harnessesPath?: string;
  /** session_ended just landed (already broadcast): stop the socket or evict
   *  the mount. The host has already shut its own internals down after this
   *  returns control via stop(). */
  readonly onEnded: () => void;
  /**
   * Hand a request to the owning Bun server as a WebSocket, carrying the join
   * to run when it opens. Only the server that bound the port can upgrade, and
   * this host may be one of many mounted on it.
   *
   * Optional because a test harness drives `handle` with no server behind it;
   * without it the events route simply answers SSE, which is the same wire the
   * agent-side subscriber uses.
   */
  readonly upgrade?: Upgrade;
}

export interface SessionHost {
  /** Serve one session-relative request. `pathname` overrides the URL's own
   *  path so a mounting owner can strip its prefix. */
  readonly handle: (req: Request, pathname?: string) => Promise<Response>;
  /** Append + broadcast session_suspended, unless a subscriber arrived since
   *  the owner's idle check or the log already moved on. True = go ahead and
   *  stop/evict; false = the session is live again, leave it mounted. */
  readonly suspend: () => Promise<boolean>;
  /** Close streams, watchers and timers. Appends nothing. Idempotent. */
  readonly stop: () => void;
  /** Epoch ms of the last request or append - the owner's idle policy input. */
  readonly lastActivityAt: () => number;
  /** Agents blocked in `wait` on this session right now. The same presence the
   *  viewer shows, read by the hub's attend engine: it only delivers a batch
   *  itself when NOTHING is listening. */
  readonly agentsListening: () => number;
  /** Push a warning frame to this session's subscribers (the D-054 channel
   *  missing assets already ride). The attend engine uses it to say WHY
   *  delivery stalled - a usage-limited harness must not fail silently. */
  readonly warn: (code: string, message: string) => void;
}

export const createSessionHost = (
  paths: SessionPaths,
  options: SessionHostOptions,
): SessionHost => {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const base = options.base ?? "";

  /** Everyone watching this session, over either wire (see live.ts). */
  const subscribers = new Set<Subscriber>();
  /** Which subscribers are agents blocked in `wait` (their waker connects with
   *  ?role=agent). Presence for the viewer: "is anyone listening right now". */
  const agentSubscribers = new Set<Subscriber>();
  const encoder = new TextEncoder();
  let stopped = false;
  let lastActivity = Date.now();

  const touch = (): void => {
    lastActivity = Date.now();
  };

  /** Fan one frame out. A send that throws is a peer that is gone: drop it,
   *  which is the only way an abandoned stream leaves the set. */
  const broadcastFrame = (event: string | null, data: string): void => {
    for (const sub of subscribers) {
      try {
        sub.send(event, data);
      } catch {
        subscribers.delete(sub);
        if (agentSubscribers.delete(sub)) queueMicrotask(broadcastListeners);
      }
    }
  };

  const broadcast = (event: LogEvent): void => {
    broadcastFrame(null, JSON.stringify(event));
  };

  /** Synthetic frame (like `warning`): the count of agents currently blocked
   *  in wait. Sent whenever it changes, so the composer can say "listening". */
  const broadcastListeners = (): void => {
    broadcastFrame("listeners", JSON.stringify({ agents: agentSubscribers.size }));
  };

  // Surface denied/missing assets to subscribers as a synthetic event so the
  // chrome can show them (D-054). Encoded as an agent-less warning frame.
  const broadcastWarning = (code: string, message: string): void => {
    broadcastFrame("warning", JSON.stringify({ code, message }));
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

  /** Synthetic frame (like `listeners`): the latest reported context usage, so
   *  the header ring updates live without a full state re-fetch. */
  const broadcastContext = (usage: ContextUsage): void => {
    broadcastFrame("context", JSON.stringify(usage));
  };

  /** Synthetic frame: the artifact's sticky model/effort just changed. Two
   *  windows can be open on one session, and the picker is shared state. */
  const broadcastSelection = (response: SelectionResponse): void => {
    broadcastFrame("selection", JSON.stringify(response));
  };

  // ---- request handling -----------------------------------------------------

  /**
   * Take a subscriber onto this session, over either wire; the returned
   * release takes it back off. Both wires arrive HERE so neither can forget
   * what arriving implies: the agent-presence count, and healing a suspended
   * log.
   */
  const subscribe = (sub: Subscriber, isAgent: boolean): (() => void) => {
    // This host may have been torn down since the request was accepted. An
    // upgrade is decided in `fetch` but handed over on `open`, and the idle
    // sweep can evict in that gap - it sees no subscribers precisely BECAUSE
    // this one has not landed yet. Joining a stopped host would leave a socket
    // that is live to the browser and attached to nothing: no frames, and no
    // teardown either, since the set it would be closed from is already clear.
    // So it is turned away and told to come back, which remounts.
    if (stopped) {
      try {
        sub.close();
      } catch {
        // the peer left first; nothing to turn away
      }
      return () => {};
    }
    subscribers.add(sub);
    if (isAgent) {
      agentSubscribers.add(sub);
      broadcastListeners();
    }
    // A subscriber arriving at a suspended log is the session coming back to
    // life: heal the recorded status, or every consumer of the fold (wait, the
    // watcher's version gate, the panel) keeps acting on "suspended" while a
    // human is sitting right there watching.
    void resumeIfSuspended();
    return () => {
      subscribers.delete(sub);
      if (agentSubscribers.delete(sub)) broadcastListeners();
    };
  };

  const handleEvents = (isAgent: boolean): Response => {
    // Assigned synchronously in `start` before any frame is enqueued; the `!`
    // marks that definite assignment for the `cancel` reader below.
    let leave!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        leave = subscribe(sseSubscriber(controller), isAgent);
      },
      cancel() {
        leave();
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
    // Cmd-collected picks arrive as `targets`; `target` is DERIVED as the
    // first, never taken from the caller beside them (two sources for one
    // spot is how they drift). A singleton list normalizes to the canonical
    // single form so the log has one shape per arity.
    const targetList = parseAnchorList(body.targets, "targets");
    if (targetList && "error" in targetList) return json({ error: targetList.error }, 400);
    const anchor = targetList ? targetList[0]! : parseAnchor(body.target);
    if ("error" in anchor) return json({ error: anchor.error }, 400);
    const targets = targetList && targetList.length > 1 ? targetList : undefined;
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
        ...(targets ? { targets } : {}),
        note: body.note,
        ...(authoredAt ? { authoredAt } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
    ]);
    return json({ ok: true });
  };

  const handleFork = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    // The fork id becomes a filesystem path component in the launcher
    // (`.lucid/<name>/forks/<id>/`), so it is held to a strict safe charset -
    // no path separators or dots - not merely "non-blank" like a log-only id.
    // A blank/traversing id would also collide in the shared dedupe set (D-057).
    if (!body || typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
      return json({ error: "invalid fork id" }, 400);
    }
    if (typeof body.note !== "string" || body.note.trim() === "") {
      return json({ error: "empty fork directive" }, 400);
    }
    const anchor = parseAnchor(body.target);
    if ("error" in anchor) return json({ error: anchor.error }, 400);
    const version =
      typeof body.version === "number" && Number.isInteger(body.version) ? body.version : 0;
    // Same pasted blobs an annotation carries, just attached to a fork directive.
    const images = parseImages(body.images);
    const authoredAt =
      typeof body.authoredAt === "string" &&
      body.authoredAt.length <= 40 &&
      !Number.isNaN(Date.parse(body.authoredAt))
        ? body.authoredAt
        : undefined;
    await serverAppend([
      {
        t: "fork",
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
    if (typeof body.session === "string" && body.session !== paths.artifactPath) {
      return json({ error: "a different session is running at this address" }, 409);
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
    if (!body || typeof body.id !== "string") {
      return json({ error: "invalid question" }, 400);
    }
    const attendant = parseAttendant(body.attendant);
    // The rich grouped form (D12), when the caller sent one. Normalized and
    // re-validated HERE even though the CLI already did: the HTTP route is
    // reachable without the CLI, so the log's invariant cannot depend on which
    // writer was live. A malformed group is a 400 with the issue list, never a
    // half-shaped question the drawer would have to guess at.
    const rawGroup = body.group ?? body.questions;
    if (rawGroup !== undefined) {
      const group = normalizeQuestionGroup(rawGroup);
      const issues = validateGroup(group);
      if (issues.length > 0) return json({ error: "invalid question group", issues }, 400);
      // The legacy fields are projected from the group, never taken from the
      // caller: two sources for one question is how they drift apart.
      const legacy = legacyProjection(group);
      await serverAppend([
        {
          t: "question",
          id: body.id,
          text: legacy.text,
          ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
          ...(legacy.options ? { options: legacy.options } : {}),
          ...(legacy.multi ? { multi: true } : {}),
          group,
          ...(attendant ? { attendant } : {}),
        },
      ]);
      return json({ ok: true });
    }
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return json({ error: "invalid question" }, 400);
    }
    const options = parseQuestionOptions(body.options);
    await serverAppend([
      {
        t: "question",
        id: body.id,
        text: body.text,
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(body.multi === true && options.length > 0 ? { multi: true } : {}),
        ...(attendant ? { attendant } : {}),
      },
    ]);
    return json({ ok: true });
  };

  const handleAnswer = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    // `text` is the LEGACY answer's content, so it is required only when the
    // answer has no `items`: a grouped answer carries its content there, and
    // demanding a field it does not use would 400 a valid rich POST before the
    // shared validator ever saw it.
    if (
      !body ||
      typeof body.id !== "string" ||
      typeof body.questionId !== "string" ||
      (body.items === undefined && typeof body.text !== "string")
    ) {
      return json({ error: "invalid answer" }, 400);
    }
    const skipped = body.skipped === true;
    // "I don't understand" is not an answer and not a decline: it clears the
    // question and puts a clearer re-ask on the agent (#40).
    const unclear = !skipped && body.unclear === true;
    // Neither skip nor re-ask decides anything, so neither may carry a
    // decision: discard chosen options, the pinned region and images for both,
    // so the payload can never contradict the contract (skipped/unclear =>
    // nothing was chosen). A skip drops the text too; a re-ask keeps it,
    // because there it is not an answer but the note saying what was
    // confusing. A normal answer can be text, chosen option labels, an
    // artifact reference, and/or images - options and anchor reuse the same
    // validators as annotations.
    const decided = !skipped && !unclear;
    const text = skipped || typeof body.text !== "string" ? "" : body.text;
    const options =
      decided && Array.isArray(body.options)
        ? body.options.filter((o): o is string => typeof o === "string" && o.length > 0)
        : [];
    // Shift+cmd-collected pins arrive as `anchors`, mirroring an annotation's
    // `targets`: `anchor` derives as the first, a singleton normalizes to the
    // single form, and none of it survives a skip or re-ask (decided-only).
    const anchorList = decided ? parseAnchorList(body.anchors, "anchors") : undefined;
    if (anchorList && "error" in anchorList) return json({ error: anchorList.error }, 400);
    const anchorIn = anchorList
      ? anchorList[0]!
      : decided && body.anchor !== undefined
        ? parseAnchor(body.anchor)
        : undefined;
    if (anchorIn && "error" in anchorIn) return json({ error: anchorIn.error }, 400);
    const anchors = anchorList && anchorList.length > 1 ? anchorList : undefined;
    const images = decided ? parseImages(body.images) : [];
    // Per-item answers to a grouped question (D12), re-validated against the
    // group the ASKING event recorded - the drawer gates its submit with the
    // same validator, so this catches only a caller that bypassed it.
    let items = decided ? normalizeItemAnswers(body.items) : [];
    // A grouped answer's content lives in `items`, and its legacy `text` is a
    // DERIVED projection of them (below) - never the caller's own text beside
    // them, which would be a second source for one answer.
    let legacyText = text;
    let grouped = false;
    if (decided) {
      const state = foldLog((await readEvents(paths.logPath)).events);
      const asked = state.questions.find((q) => q.id === body.questionId);
      const group = asked?.group ?? [];
      if (group.length > 0) {
        // A client that only speaks the legacy wire answered a one-question
        // group it was shown losslessly: project rather than refuse it.
        items =
          (items.length === 0 ? projectLegacyAnswer(group, { text, options }) : items) ?? items;
        const hasAttachments = anchorIn !== undefined || images.length > 0;
        const issues = validateAnswer(group, { items }, { hasAttachments });
        if (issues.length > 0) return json({ error: "invalid answer", issues }, 400);
        grouped = true;
        // The legacy projection of a rich answer. A reader that knows only
        // `text`/`options` would otherwise see an answered question with no
        // answer at all, which is not additive.
        legacyText = summarizeAnswer(group, items);
      } else if (items.length > 0) {
        return json(
          {
            error: "invalid answer",
            issues: [
              {
                code: "unknown_question",
                message: `Question "${body.questionId}" has no grouped contract.`,
                questionId: body.questionId,
              },
            ],
          },
          400,
        );
      }
    }
    // Must carry something - UNLESS the human declined (skip) or said the
    // question was unclear (re-ask, where a bare one is allowed - not
    // understanding is the point). A bare ordinary submission is rejected.
    if (
      decided &&
      text.trim() === "" &&
      options.length === 0 &&
      items.length === 0 &&
      !anchorIn &&
      images.length === 0
    ) {
      return json({ error: "empty answer" }, 400);
    }
    await serverAppend([
      {
        t: "question_answered",
        id: body.id,
        questionId: body.questionId,
        text: legacyText,
        ...(skipped ? { skipped: true } : {}),
        ...(unclear ? { unclear: true } : {}),
        ...(!grouped && options.length > 0 ? { options } : {}),
        ...(items.length > 0 ? { items } : {}),
        ...(anchorIn ? { anchor: anchorIn } : {}),
        ...(anchors ? { anchors } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
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

  /**
   * Rename the artifact: rewrite its `<title>` text. The document's own title
   * is the ONE name every surface reads - the tab label, the hub listing, the
   * shell window - so renaming edits the document rather than growing a second
   * name store that would drift from it. The watcher commits the edit as a
   * version like any other change, so a rename is in history and revertable.
   */
  const handleRename = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.title !== "string") return json({ error: "invalid title" }, 400);
    // One line, bounded: this lands inside a <title> element and on a tab.
    const title = body.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (title === "") return json({ error: "a title cannot be empty" }, 400);
    const html = await readArtifact(paths);
    // The DOCUMENT's title, by parsing - a bare regex over source finds the
    // first title-SHAPED substring, which can live inside a <script> string or
    // a comment, and editing that leaves document.title untouched.
    const current = parseHTML(html).document.querySelector("title")?.textContent ?? null;
    if (current === null) return json({ error: "the artifact has no <title> to rename" }, 400);
    // Compare-and-set: the transport retries POSTs, and a lost-response retry
    // of an OLD rename landing after a newer one must not roll it back.
    // Advisory - a caller that does not know the current title omits it.
    if (typeof body.replaces === "string" && body.replaces !== current) {
      return json({ error: "the title changed underneath this rename" }, 409);
    }
    // Serializing the parsed DOM back out would reformat the agent's whole
    // document, so the edit stays a string replace - scoped to the source run
    // of the REAL title: the tag whose inner text is the parsed title, in the
    // pre-<body> region. Entities make the source spelling ambiguous, so both
    // the decoded and the escaped spellings are tried.
    const headEnd = /<body[\s>]/i.exec(html)?.index ?? html.length;
    const head = html.slice(0, headEnd);
    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let span: { start: number; end: number } | null = null;
    for (const text of [current, escapeHtml(current)]) {
      const m = new RegExp(`<title[^>]*>\\s*${escapeRegExp(text)}\\s*</title>`, "i").exec(head);
      if (m) {
        span = { start: m.index, end: m.index + m[0].length };
        break;
      }
    }
    if (span === null) {
      return json({ error: "could not locate the <title> in the document source" }, 409);
    }
    const next = `${html.slice(0, span.start)}<title>${escapeHtml(title)}</title>${html.slice(span.end)}`;
    // Last look before writing: an agent save that landed while this handler
    // ran must not be overwritten with a stale document. Not a lock - the
    // artifact file is a shared medium by design - but it shrinks the window
    // from the whole handler to one syscall's worth.
    if ((await readArtifact(paths)) !== html) {
      return json({ error: "the artifact changed while renaming - try again" }, 409);
    }
    atomicWrite(paths.artifactPath, next);
    // Commit deterministically rather than waiting out the watcher debounce:
    // the caller's optimistic label is confirmed by the version broadcast.
    await commitNow();
    return json({ ok: true, title });
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

  /** Serve a past version's full snapshot, read-only, for the history viewer.
   *  The current version is served live from `/__lucid/artifact`; this is only
   *  ever a prior snapshot, looked up by its version ref within the segment. */
  const handleVersion = async (url: URL): Promise<Response> => {
    const state = foldLog((await readEvents(paths.logPath)).events);
    const v = Number.parseInt(url.searchParams.get("v") ?? "", 10);
    const ref = versionRef(state, v);
    if (!ref || !Number.isFinite(v)) return json({ error: "unknown version" }, 404);
    const html = await readFile(join(paths.sessionDir, ref.path), "utf8").catch(() => null);
    if (html === null) return json({ error: "snapshot unavailable" }, 404);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", ...noStore },
    });
  };

  const handleAck = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string") return json({ error: "invalid ack" }, 400);
    const intent = body.intent === "revise" || body.intent === "reply" ? body.intent : undefined;
    const progress = sanitizeProgress(body.progress);
    const attendant = parseAttendant(body.attendant);
    // The delivered range (D20). A non-integer or negative claim is dropped
    // rather than clamped: the panel says "recorded" instead of asserting a
    // delivery from a value the writer got wrong.
    const covers =
      typeof body.covers === "number" && Number.isInteger(body.covers) && body.covers >= 0
        ? body.covers
        : undefined;
    // Which turn this ack belongs to (D-013). Bounded like every other
    // caller-supplied identifier; absent is the anonymous turn, which is how
    // every pre-turnId writer folds.
    const turnId =
      typeof body.turnId === "string" && body.turnId.length > 0
        ? body.turnId.slice(0, 128)
        : undefined;
    await serverAppend([
      {
        t: "agent_ack",
        id: body.id,
        ...(intent ? { intent } : {}),
        ...(progress ? { progress } : {}),
        ...(covers !== undefined ? { covers } : {}),
        ...(turnId ? { turnId } : {}),
        ...(attendant ? { attendant } : {}),
      },
    ]);
    return json({ ok: true });
  };

  /**
   * `POST /__lucid/turn-ended` - a turn saying it stopped (plan 08, RFC-01).
   *
   * Every field is a CLOSED set, refused rather than coerced. A `reason` this
   * build does not know is not a shortened one and a `code` outside the
   * charset is not a truncated identifier - both are something else, and
   * accepting a cleaned-up version of them is how prose gets into a record.
   * There is deliberately no free-text field to validate.
   */
  const handleTurnEnded = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.turnId !== "string" || body.turnId.length === 0) {
      return json({ error: "invalid turnId" }, 400);
    }
    if (typeof body.reason !== "string" || !TURN_END_REASONS.has(body.reason)) {
      return json({ error: "invalid reason" }, 400);
    }
    if (
      body.code !== undefined &&
      (typeof body.code !== "string" || !TURN_END_CODE.test(body.code))
    ) {
      return json({ error: "invalid code" }, 400);
    }
    const attendant = parseAttendant(body.attendant);
    await serverAppend([
      {
        t: "agent_turn_ended",
        turnId: body.turnId.slice(0, 128),
        reason: body.reason as TurnEndReason,
        ...(typeof body.code === "string" ? { code: body.code } : {}),
        ...(attendant ? { attendant } : {}),
      },
    ]);
    return json({ ok: true });
  };

  const handleReply = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.text !== "string") {
      return json({ error: "invalid reply" }, 400);
    }
    const attendant = parseAttendant(body.attendant);
    await serverAppend([
      { t: "agent_reply", id: body.id, text: body.text, ...(attendant ? { attendant } : {}) },
    ]);
    return json({ ok: true });
  };

  const handleContext = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const clean = body ? sanitizeContext(body) : undefined;
    if (!clean) return json({ error: "invalid context" }, 400);
    const usage: ContextUsage = { ...clean, at: new Date().toISOString() };
    // Sidecar, not the log: usage is overwritten every turn (D-051 pattern).
    await writeContextSidecar(paths, usage);
    broadcastContext(usage);
    touch();
    return json({ ok: true });
  };

  /**
   * The harness whose model/effort vocabulary applies to THIS artifact: the
   * one its own log records, else the registry default for an artifact that
   * has not been attended yet. Exact match only, like the attend engine - a
   * recorded harness the registry lacks has no vocabulary to offer, and the
   * default is not a stand-in for it.
   */
  const selectionHarness = async (): Promise<
    { readonly name: string; readonly recipe: SpawnRecipe } | undefined
  > => {
    const registry = await loadRegistry(options.harnessesPath).catch(() => null);
    if (!registry) return undefined;
    const state = foldLog((await readEvents(paths.logPath)).events);
    const recorded = [...state.sessionHistory].reverse().find((r) => r.harness)?.harness;
    const found = resolveRecipe(registry, recorded);
    // Normalized: a registry keyed `claude_code` IS the `claude-code` an
    // artifact records. Comparing raw meant a fresh artifact stamped by an
    // agent had no vocabulary at all - no model picker, no effort picker -
    // purely because of a separator.
    return found &&
      (recorded === undefined || normalizeHarness(found.name) === normalizeHarness(recorded))
      ? found
      : undefined;
  };

  /** The selection route's answer: the sticky pick plus the vocabulary it was
   *  made in, so a picker can render without the hub's identity call (a
   *  dedicated `lucid open` server has no hub). */
  const selectionResponse = async (
    resolved: { readonly name: string; readonly recipe: SpawnRecipe } | undefined,
  ): Promise<SelectionResponse> => ({
    selection: (await readSelection(paths)) ?? {},
    ...(resolved
      ? {
          harness: resolved.name,
          info: {
            name: resolved.name,
            ...(resolved.recipe.models ? { models: resolved.recipe.models } : {}),
            ...(resolved.recipe.defaultModel !== undefined
              ? { defaultModel: resolved.recipe.defaultModel }
              : {}),
            ...(resolved.recipe.efforts ? { efforts: resolved.recipe.efforts } : {}),
            ...(resolved.recipe.defaultEffort !== undefined
              ? { defaultEffort: resolved.recipe.defaultEffort }
              : {}),
          },
        }
      : {}),
  });

  /**
   * `{base}/__lucid/selection`: the artifact's sticky model/effort, which
   * every later UNATTENDED turn reuses. Validated against the registry the
   * spawner will use, so a pick that cannot run is refused here with the
   * adapter's own words instead of dying as a dead agent turn. A POST replaces
   * the WHOLE selection, and a body with no usable fields CLEARS it -
   * "default" means the CLI decides.
   */
  const handleSelection = async (req: Request): Promise<Response> => {
    const resolved = await selectionHarness();
    if (req.method === "GET") return json(await selectionResponse(resolved), 200, noStore);
    // Clearing the pick is destructive and must be ASKED for: a body that did
    // not parse as an object is a malformed request, not an empty selection,
    // so a truncated or bodyless POST is refused instead of silently wiping
    // what every later unattended turn reuses.
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return json({ error: "selection body must be a JSON object" }, 400);
    }
    const selection = sanitizeSelection({ model: body.model, effort: body.effort });
    if (selection) {
      if (!resolved) {
        return json({ error: "this artifact has no harness recipe to validate a selection" }, 400);
      }
      const args = selectionArgs(resolved.name, resolved.recipe, selection);
      if ("error" in args) return json({ error: args.error }, 400);
    }
    await writeSelection(paths, {
      ...(selection && resolved ? { harness: resolved.name } : {}),
      ...(selection ?? {}),
    });
    const response = await selectionResponse(resolved);
    broadcastSelection(response);
    touch();
    return json(response);
  };

  const handle = async (req: Request, pathnameOverride?: string): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = pathnameOverride ?? url.pathname;

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
      return new Response((await readDevAsset("client.js")) ?? CLIENT_BUNDLE, { headers });
    }

    const headerCheck = validateHeaders(req, options.getPort());
    if (!headerCheck.ok) {
      return json({ error: `forbidden: ${headerCheck.reason}` }, 403);
    }
    touch();

    // ---- control routes (reserved prefix) ----
    if (pathname === "/__lucid/identity") {
      return json({
        lucid: true,
        session: paths.artifactPath,
        port: options.getPort(),
        version: await currentVersion(),
      });
    }
    if (pathname === "/__lucid/viewer") {
      return new Response(
        renderViewer({
          session: paths.artifactPath,
          name: basename(paths.artifactPath),
          port: options.getPort(),
          version: await currentVersion(),
          base,
          ...((backoff) => (backoff === undefined ? {} : { sseMaxBackoffMs: backoff }))(
            sseMaxBackoffFromEnv(),
          ),
        }),
        { headers: { "content-type": "text/html; charset=utf-8", ...noStore } },
      );
    }
    // The chrome's own bundle + stylesheet. Unlike the overlay these stay
    // behind the Host/Origin gate: they are same-origin requests from Lucid's
    // viewer page, and nothing in the sandboxed artifact should reach them.
    if (pathname === "/__lucid/chrome.js") {
      return new Response((await readDevAsset("chrome.js")) ?? CHROME_BUNDLE, {
        headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/chrome.css") {
      return new Response((await readDevAsset("chrome.css")) ?? CHROME_CSS, {
        headers: { "content-type": "text/css; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/events") {
      const isAgent = url.searchParams.get("role") === "agent";
      // The browser upgrades (its six-per-origin HTTP pool is the whole reason
      // live.ts exists); `lucid wait`'s subscriber keeps the SSE wire. The
      // Host/Origin gate above has already run, which matters MORE here: a
      // WebSocket handshake is not subject to CORS at all.
      if (wantsUpgrade(req)) {
        return options.upgrade?.(req, new LiveSocket((sub) => subscribe(sub, isAgent))) === true
          ? UPGRADED
          : json({ error: "websocket upgrade refused" }, 400);
      }
      return handleEvents(isAgent);
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
      // Is that conversation open in a terminal right now? Resolved per
      // request (the panel polls state, and a human resuming in a terminal
      // must flip the mode within a beat, not on a restart).
      // The SAME resolution the attend engine uses, so the panel's idea of
      // whose conversation this is can never differ from the hub's.
      const target = await artifactAttendant(paths, state.sessionHistory);
      const stampedHarness = [...state.sessionHistory].reverse().find((r) => r.harness);
      const presence = await presenceFor(target, paths.artifactDir);
      const contextUsage = await readContextSidecar(paths);
      const selection = await readSelection(paths);
      // Resumable = the engine has something to re-enter. Same resolution the
      // attend engine uses, so the panel cannot promise a turn it will refuse.
      const knownSessionId =
        target?.sessionId ??
        harnessSessionId({
          ...(target?.resume ? { resume: target.resume } : {}),
          artifactDir: paths.artifactDir,
        });
      const resumable = knownSessionId !== undefined;
      // A command the human can paste, offered whenever the session is KNOWN -
      // not only when an agent happened to write one down. Recorded first: it
      // carries the agent's own flags.
      const settings = await readSettingsCached();
      const resumeCommand =
        attendant?.resume ??
        (target?.harness && knownSessionId
          ? interactiveResumeCommand(target.harness, knownSessionId, {
              yolo: settings.resumeYolo,
            })
          : undefined);
      const response: StateResponse = {
        ...payload,
        agentsListening: agentSubscribers.size,
        resumable,
        ...(presence
          ? {
              attendantPresence: {
                interactive: presence.interactive,
                ...(presence.status ? { status: presence.status } : {}),
                ...(presence.cwd ? { cwd: presence.cwd } : {}),
              },
            }
          : {}),
        // The sidecar when there is one (it carries the resume command and the
        // attending session's model/effort); otherwise the harness the LOG
        // records, so a fresh artifact still NAMES its agent. Without this the
        // panel called a stamped claude-code session "the agent".
        ...(attendant
          ? {
              lastAttendant: {
                harness: attendant.harness,
                at: attendant.at,
                ...(resumeCommand ? { resume: resumeCommand } : {}),
                ...(attendant.model ? { model: attendant.model } : {}),
                ...(attendant.effort ? { effort: attendant.effort } : {}),
              },
            }
          : stampedHarness
            ? {
                lastAttendant: {
                  harness: stampedHarness.harness,
                  at: stampedHarness.lastAt,
                  ...(resumeCommand ? { resume: resumeCommand } : {}),
                },
              }
            : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(selection ? { selection } : {}),
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
    if (pathname === "/__lucid/selection" && (req.method === "GET" || req.method === "POST")) {
      return handleSelection(req);
    }
    if (pathname === "/__lucid/diff") return handleDiff(url);
    if (pathname === "/__lucid/version") return handleVersion(url);
    if (pathname === "/__lucid/annotation" && req.method === "POST") return handleAnnotation(req);
    if (pathname === "/__lucid/fork" && req.method === "POST") return handleFork(req);
    if (pathname === "/__lucid/message" && req.method === "POST") return handleMessage(req);
    if (pathname === "/__lucid/revert" && req.method === "POST") return handleRevert(req);
    if (pathname === "/__lucid/rename" && req.method === "POST") return handleRename(req);
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
    if (pathname === "/__lucid/turn-ended" && req.method === "POST") return handleTurnEnded(req);
    if (pathname === "/__lucid/context" && req.method === "POST") return handleContext(req);
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
      queueMicrotask(() => options.onEnded());
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
      if (html === null) {
        // This renders INSIDE the surface iframe - raw JSON there reads as a
        // broken app. Say what is actually wrong, as a document.
        return new Response(
          `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Artifact missing</title></head>
<body style="font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#4c566a;background:#eceff4">
<div style="max-width:420px;text-align:center;font-size:13px;line-height:1.6">
<p style="font-weight:600">This session's artifact file is missing.</p>
<p>Nothing is served for it right now - the file may have been moved or deleted. Reopening it (<code>lucid open</code> on the artifact) rebuilds this view.</p>
</div>
</body></html>`,
          { status: 404, headers: { "content-type": "text/html; charset=utf-8", ...noStore } },
        );
      }
      const injected = renderInjected(html, base, new URL(req.url).origin);
      return new Response(injected.body, {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore, ...injected.headers },
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

  // ---- artifact change detection --------------------------------------------
  // commitNow() is driven by BOTH fs.watch and a polling fallback: fs.watch is
  // not guaranteed (Node documents this) and is unreliable through a symlinked
  // path (e.g. macOS /tmp -> /private/tmp) or across atomic-rename saves, so a
  // 1s hash poll guarantees a settled change is committed regardless.
  const artifactBase = basename(paths.artifactPath);
  let committing = false;
  /** A change arrived while a commit was mid-flight. Silently RETURNING there
   *  lost the newer bytes until the next unrelated event: the in-flight commit
   *  records what it already read, the poll has advanced its stat baseline,
   *  and a caller who awaited commitNow (the rename route) got a resolved
   *  promise for a commit that never ran. Queue one rerun instead. */
  let commitQueued = false;
  const commitNow = async (): Promise<void> => {
    if (committing) {
      commitQueued = true;
      return;
    }
    committing = true;
    try {
      do {
        commitQueued = false;
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
          // transient; the poll (or the queued rerun) retries
        }
      } while (commitQueued);
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

  /**
   * Synthetic frame (like `listeners`): whether the artifact's own harness
   * conversation is open in a terminal right now.
   *
   * Polled, because nothing writes to the LOG when a human opens or closes a
   * terminal - and without a push the panel kept saying "running in claude-code"
   * at a session that had exited, or offered a resume command for one already
   * running, until some unrelated event happened to land. Only broadcast on
   * CHANGE, and the sweep behind it is cached, so a quiet session costs a
   * directory read every few seconds.
   */
  let lastPresence = "";
  const presenceTimer = setInterval(() => {
    void (async () => {
      if (subscribers.size === 0) return; // nobody is looking
      try {
        const state = foldLog((await readEvents(paths.logPath)).events);
        const target = await artifactAttendant(paths, state.sessionHistory);
        const live = await presenceFor(target, paths.artifactDir);
        const frame = live
          ? JSON.stringify({
              interactive: live.interactive,
              ...(live.status ? { status: live.status } : {}),
              ...(live.cwd ? { cwd: live.cwd } : {}),
            })
          : "null";
        if (frame === lastPresence) return;
        lastPresence = frame;
        broadcastFrame("presence", frame);
      } catch {
        /* a presence sweep that fails is not worth tearing the stream down */
      }
    })();
  }, 3000);

  /**
   * Idle-suspend, CONDITIONALLY: false means "do not evict me". The idle
   * owner's check and its suspend are separated by an await, so a subscriber
   * can connect in the gap - suspending then would append over their fresh
   * `session_resumed` and close the stream they just opened. The subscriber
   * check is re-run here, and the append is guarded on the log still being
   * active so stacked idle ticks cannot append a second suspend. An
   * already-suspended/ended log still answers true: eviction is about memory,
   * and a mount nobody watches on a closed log has no reason to live.
   */
  const suspend = async (): Promise<boolean> => {
    if (subscribers.size > 0) return false;
    const appended = await appendEventsIf(
      paths.logPath,
      (existing) => foldLog(existing).status === "active",
      [{ t: "session_suspended" }],
    );
    if (appended.length > 0) {
      // Broadcast like serverAppend would: a subscriber that squeezed in
      // after the size check above still learns of the suspend before the
      // owner closes the streams (and its reconnect heals the log).
      for (const e of appended) broadcast(e);
      touch();
      return true;
    }
    return subscribers.size === 0;
  };

  /**
   * Heal a suspended log when someone connects (the idle-suspend loop's other
   * half). Suspend evicts the mount but the viewer's stream retries and
   * remounts - and nothing appended `session_resumed`, so the folded status
   * stayed "suspended" for as long as the tab lived. Every consumer of that
   * fold then acted on it: `lucid wait` told the agent the review was paused,
   * the watcher refused to commit the agent's saved revision as a version, and
   * the attend relay misread the finished turn as silent.
   *
   * Guarded inside the log lock, so two tabs connecting at once append one
   * resume, not two; no attendant stamp - a watching human resumed it, not an
   * agent turn. The reconcile after it picks up an artifact change that landed
   * while the status wrongly said suspended.
   */
  const resumeIfSuspended = async (): Promise<void> => {
    try {
      const state = foldLog((await readEvents(paths.logPath)).events);
      if (state.status !== "suspended") return;
      const appended = await appendEventsIf(
        paths.logPath,
        (existing) => foldLog(existing).status === "suspended",
        [{ t: "session_resumed", segment: state.segment }],
      );
      if (appended.length === 0) return;
      for (const e of appended) broadcast(e);
      touch();
      // Against the SNAPSHOT, not current.html: the suspend bug's damage is a
      // serve cache that already matches the artifact while the log is a
      // version behind - a cache comparison reads that as "no change" and
      // leaves the revision out of the log forever. Committed history can't
      // be clobbered that way. (Best-effort like the resume itself: if this
      // throws, the log is healed and the next save reconciles.)
      const result = await commitAgainstSnapshot(paths);
      if (result.committed) broadcast(result.committed);
      else if (result.warning) broadcastWarning(result.warning.code, result.warning.message);
    } catch {
      // Best-effort: a failed heal leaves exactly the state we arrived in,
      // and the next subscriber retries it.
    }
  };

  const stop = (): void => {
    clearInterval(presenceTimer);
    if (stopped) return;
    stopped = true;
    if (watcher) watcher.close();
    if (debounce) clearTimeout(debounce);
    clearInterval(pollTimer);
    for (const sub of subscribers) {
      try {
        sub.close();
      } catch {
        // already closed
      }
    }
    subscribers.clear();
    agentSubscribers.clear();
  };

  return {
    handle,
    suspend,
    stop,
    // A live subscriber IS activity: requests only touch the clock when they
    // arrive, so an open tab (one long SSE request) or an agent blocked in
    // `wait` idled out at 30 minutes and was suspended mid-watch. The idle
    // timers (daemon and dedicated server) both read this, so neither needs
    // its own notion of "someone is here".
    lastActivityAt: () => (subscribers.size > 0 ? Date.now() : lastActivity),
    agentsListening: () => agentSubscribers.size,
    warn: broadcastWarning,
  };
};
