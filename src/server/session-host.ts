import { mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { basename, join } from "node:path";
import { parseAnchor, type Anchor } from "../anchors/anchor.ts";
import {
  asString,
  decodeAck,
  decodeAnnotation,
  decodeBind,
  decodeClear,
  decodeEnd,
  decodeFork,
  decodeMessage,
  decodeRename,
  decodeReopen,
  decodeReply,
  decodeResolve,
  decodeRevert,
  decodeTurnEnded,
} from "../protocol/inbound.ts";
import { type HarnessPresence, presenceFor } from "../core/presence.ts";
import { viewerState } from "../core/viewer-state.ts";
import { artifactAttendant } from "../core/attendant.ts";
import { sanitizeContext, writeContextSidecar } from "../core/context.ts";
import { diffHtml } from "../diff/diff.ts";
import { versionRef } from "../core/fold.ts";
import { sanitizeAttendant } from "../core/events.ts";
import { appendSessionBindings } from "../core/deliver.ts";
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
import { appendEvents, appendIfStatus, sessionState } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { listSessions } from "../core/sessions.ts";
import { artifactCheckout } from "../core/project.ts";
import { commitAgainstSnapshot, readArtifact } from "../core/session.ts";
import { writeTextAtomicSync } from "../core/atomic-json.ts";
import { createArtifactWatch } from "./artifact-watch.ts";
import type { ErrorIdentity, RequestObservation } from "./observe.ts";
import { escapeHtml } from "../core/escape.ts";
import {
  defaultRecipe,
  harnessInfoOf,
  loadRegistry,
  resolveExactRecipe,
  type SpawnRecipe,
} from "../launch/recipes.ts";
import {
  readSelection,
  sanitizeSelection,
  selectionArgs,
  writeSelection,
} from "../launch/selection.ts";
import { DEFAULT_FRAME, type SessionFrame } from "../protocol/frames.ts";
import type {
  AttendantPresence,
  ContextUsage,
  SelectionResponse,
  SessionsResponse,
} from "../protocol/wire.ts";
import { multiTargets } from "../protocol/wire.ts";
import { serveBundleAsset } from "./assets.ts";
import { createChannel, wantsUpgrade, type Subscriber, type Upgrade } from "./live.ts";
import { resolveAsset, validateHeaders } from "./security.ts";
import { artifactDocumentResponse, viewerResponse } from "./viewer.ts";

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

/**
 * The current request's observation, for guard refusals that live in the route
 * handlers (the decode refusals) to record without threading the observation
 * through every handler signature. Set at the top of `handle` per request;
 * each request is its own async frame, so one store cannot leak into another.
 */
const observationContext = new AsyncLocalStorage<RequestObservation | undefined>();
/** Record a typed guard refusal onto the current request's observation, if any.
 *  The decode refusals carry a string reason (not a typed error), so the
 *  identity is synthesized from the refusal kind; the RESPONSE still carries
 *  the reason. */
const recordRefusal = (identity: ErrorIdentity): void => {
  observationContext.getStore()?.fail(identity);
};

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
  readonly handle: (
    req: Request,
    pathname?: string,
    observation?: RequestObservation,
  ) => Promise<Response>;
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

  /** Which subscribers are agents blocked in `wait` (their waker connects with
   *  ?role=agent). Presence for the viewer: "is anyone listening right now". */
  const agentSubscribers = new Set<Subscriber>();
  let stopped = false;
  let lastActivity = Date.now();

  const touch = (): void => {
    lastActivity = Date.now();
  };

  /**
   * Everyone watching this session, over either wire (live.ts owns the set,
   * both wires and the drop-on-throw rule). The join value is "is this an
   * agent", and both hooks are what arriving and leaving IMPLY here: the
   * agent-presence count, and healing a suspended log.
   */
  const channel = createChannel<SessionFrame, boolean>({
    onJoin: (sub, isAgent) => {
      if (isAgent) {
        agentSubscribers.add(sub);
        broadcastListeners();
      }
      // A subscriber arriving at a suspended log is the session coming back to
      // life: heal the recorded status, or every consumer of the fold (wait,
      // the watcher's version gate, the panel) keeps acting on "suspended"
      // while a human is sitting right there watching.
      void resumeIfSuspended();
    },
    // A peer the fan-out dropped left too, so the count cannot outlive it.
    onLeave: (sub) => {
      if (agentSubscribers.delete(sub)) broadcastListeners();
    },
  });

  const broadcastFrame = channel.send;

  const broadcast = (event: LogEvent): void => {
    broadcastFrame({ event: DEFAULT_FRAME, data: event });
  };

  /** Synthetic frame (like `warning`): the count of agents currently blocked
   *  in wait. Sent whenever it changes, so the composer can say "listening". */
  const broadcastListeners = (): void => {
    broadcastFrame({ event: "listeners", data: { agents: agentSubscribers.size } });
  };

  // Surface denied/missing assets to subscribers as a synthetic event so the
  // chrome can show them (D-054). Encoded as an agent-less warning frame.
  const broadcastWarning = (code: string, message: string): void => {
    broadcastFrame({ event: "warning", data: { code, message } });
  };

  const serverAppend = async (inputs: readonly EventInput[]): Promise<readonly LogEvent[]> => {
    const events = await appendEvents(paths, inputs);
    for (const e of events) broadcast(e);
    touch();
    return events;
  };

  const currentVersion = async (): Promise<number> => {
    const state = await sessionState(paths);
    return state.version;
  };

  /** Synthetic frame (like `listeners`): the latest reported context usage, so
   *  the header ring updates live without a full state re-fetch. */
  const broadcastContext = (usage: ContextUsage): void => {
    broadcastFrame({ event: "context", data: usage });
  };

  /** Synthetic frame: the artifact's sticky model/effort just changed. Two
   *  windows can be open on one session, and the picker is shared state. */
  const broadcastSelection = (response: SelectionResponse): void => {
    broadcastFrame({ event: "selection", data: response });
  };

  /**
   * The wire's view of a live harness conversation: the presence sweep's record
   * narrowed to the three facts that cross the boundary. One projection,
   * because the state route and the presence frame answer the same question -
   * spelled twice, they were free to disagree about it.
   */
  const attendantPresenceOf = (live: HarnessPresence | undefined): AttendantPresence | null =>
    live
      ? {
          interactive: live.interactive,
          ...(live.status ? { status: live.status } : {}),
          ...(live.cwd ? { cwd: live.cwd } : {}),
        }
      : null;

  // ---- request handling -----------------------------------------------------

  const handleAnnotation = async (req: Request): Promise<Response> => {
    const result = decodeAnnotation(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    await serverAppend([result.value]);
    return json({ ok: true });
  };

  const handleFork = async (req: Request): Promise<Response> => {
    const result = decodeFork(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    await serverAppend([result.value]);
    return json({ ok: true });
  };

  const handleMessage = async (req: Request): Promise<Response> => {
    const raw = await req.json().catch(() => null);
    const result = decodeMessage(raw);
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    // The session check stays in the handler: it reads `paths.artifactPath`,
    // which the decoder (a pure function of the body) does not know.
    if (
      typeof (raw as { session?: unknown })?.session === "string" &&
      (raw as { session: string }).session !== paths.artifactPath
    ) {
      return json({ error: "a different session is running at this address" }, 409);
    }
    await serverAppend([result.value]);
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
    const id = asString(body?.id);
    if (!body || id === undefined) {
      return json({ error: "invalid question" }, 400);
    }
    const ref = asString(body.ref);
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
          id,
          text: legacy.text,
          ...(ref ? { ref } : {}),
          ...(legacy.options ? { options: legacy.options } : {}),
          ...(legacy.multi ? { multi: true } : {}),
          group,
          ...(attendant ? { attendant } : {}),
        },
      ]);
      return json({ ok: true });
    }
    const text = asString(body.text);
    if (text === undefined || text.trim() === "") {
      return json({ error: "invalid question" }, 400);
    }
    const options = parseQuestionOptions(body.options);
    await serverAppend([
      {
        t: "question",
        id,
        text,
        ...(ref ? { ref } : {}),
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
    const ansId = asString(body?.id);
    const questionId = asString(body?.questionId);
    if (
      !body ||
      ansId === undefined ||
      questionId === undefined ||
      (body.items === undefined && asString(body.text) === undefined)
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
    const bodyText = asString(body.text);
    const text = skipped || bodyText === undefined ? "" : bodyText;
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
    const anchors = multiTargets(anchorList);
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
      const state = await sessionState(paths);
      const asked = state.questions.find((q) => q.id === questionId);
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
                questionId: questionId,
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
        id: ansId,
        questionId,
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
    const result = decodeRevert(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    await serverAppend([result.value]);
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
    const result = decodeRename(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    const { title, replaces } = result.value;
    const html = await readArtifact(paths);
    // The DOCUMENT's title, by parsing - a bare regex over source finds the
    // first title-SHAPED substring, which can live inside a <script> string or
    // a comment, and editing that leaves document.title untouched.
    const current = parseHTML(html).document.querySelector("title")?.textContent ?? null;
    if (current === null) return json({ error: "the artifact has no <title> to rename" }, 400);
    // Compare-and-set: the transport retries POSTs, and a lost-response retry
    // of an OLD rename landing after a newer one must not roll it back.
    // Advisory - a caller that does not know the current title omits it.
    if (replaces !== undefined && replaces !== current) {
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
    writeTextAtomicSync(paths.artifactPath, next);
    // Commit deterministically rather than waiting out the watcher debounce:
    // the caller's optimistic label is confirmed by the version broadcast.
    await artifactWatch.commitNow();
    return json({ ok: true, title });
  };

  /** Diff the current artifact against a base version (RFC §8). */
  const handleDiff = async (url: URL): Promise<Response> => {
    const state = await sessionState(paths);
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
    const state = await sessionState(paths);
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
    const result = decodeAck(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    await serverAppend([result.value]);
    return json({ ok: true });
  };

  /**
   * `POST /__lucid/bind` - a launch announcing which harness-native session it
   * bound (plan 03, M2). Validation is refusal, not coercion: a stamp that
   * cannot vouch (no sessionId, no authority) or a malformed launchId is a
   * 400, never a cleaned-up record. The append goes through the ONE binding
   * writer - after-open guard, derived idempotency id - and only the events
   * that are genuinely fresh are broadcast: a re-announced binding is one log
   * line and one frame, however many times it arrives.
   */
  const handleBind = async (req: Request): Promise<Response> => {
    const decoded = decodeBind(await req.json().catch(() => null));
    if (!decoded.ok) return json({ error: decoded.error }, 400);
    const result = await appendSessionBindings(paths, [decoded.value]);
    if (!result.opened) return json({ error: "session not opened" }, 409);
    for (const e of result.fresh) broadcast(e);
    touch();
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
    const result = decodeTurnEnded(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    await serverAppend([result.value]);
    return json({ ok: true });
  };

  const handleReply = async (req: Request): Promise<Response> => {
    const result = decodeReply(await req.json().catch(() => null));
    if (!result.ok) {
      recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      return json({ error: result.error }, 400);
    }
    await serverAppend([result.value]);
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
    const selection = await readSelection(paths);
    const state = await sessionState(paths);
    const recorded = [...state.sessionHistory].reverse().find((r) => r.harness)?.harness;
    const wanted = selection?.harness ?? recorded;
    // Nothing selected and nothing recorded is not an unlisted harness: the
    // artifact has no harness at all yet, and the default's vocabulary is the
    // right one to offer it.
    return wanted === undefined ? defaultRecipe(registry) : resolveExactRecipe(registry, wanted);
  };

  /** The selection route's answer: the sticky pick plus the vocabulary it was
   *  made in, so a picker can render without the hub's identity call (a
   *  dedicated `lucid open` server has no hub). */
  const selectionResponse = async (
    resolved: { readonly name: string; readonly recipe: SpawnRecipe } | undefined,
  ): Promise<SelectionResponse> => {
    const registry = await loadRegistry(options.harnessesPath).catch(() => null);
    return {
      selection: (await readSelection(paths)) ?? {},
      ...(resolved
        ? { harness: resolved.name, info: harnessInfoOf(resolved.name, resolved.recipe) }
        : {}),
      ...(registry
        ? {
            harnesses: Object.entries(registry.harnesses).map(([name, recipe]) =>
              harnessInfoOf(name, recipe),
            ),
          }
        : {}),
    };
  };

  /**
   * `{base}/__lucid/selection`: the artifact's sticky model/effort, which
   * every later UNATTENDED turn reuses. Validated against the registry the
   * spawner will use, so a pick that cannot run is refused here with the
   * adapter's own words instead of dying as a dead agent turn. A POST replaces
   * the WHOLE selection, and a body with no usable fields CLEARS it -
   * "default" means the CLI decides.
   */
  const handleSelection = async (req: Request): Promise<Response> => {
    const current = await selectionHarness();
    if (req.method === "GET") return json(await selectionResponse(current), 200, noStore);
    // Clearing the pick is destructive and must be ASKED for: a body that did
    // not parse as an object is a malformed request, not an empty selection,
    // so a truncated or bodyless POST is refused instead of silently wiping
    // what every later unattended turn reuses.
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return json({ error: "selection body must be a JSON object" }, 400);
    }
    const selection = sanitizeSelection({
      harness: body.harness,
      model: body.model,
      effort: body.effort,
    });
    let resolved = current;
    if (selection?.harness) {
      const registry = await loadRegistry(options.harnessesPath).catch(() => null);
      resolved = registry ? resolveExactRecipe(registry, selection.harness) : undefined;
    }
    if (selection) {
      if (!resolved) {
        return json(
          { error: `harness "${selection.harness ?? "unknown"}" is not configured` },
          400,
        );
      }
      const args = selectionArgs(resolved.name, resolved.recipe, selection);
      if ("error" in args) return json({ error: args.error }, 400);
    }
    await writeSelection(paths, {
      ...(selection ?? {}),
      ...(selection && resolved ? { harness: resolved.name } : {}),
    });
    const response = await selectionResponse(await selectionHarness());
    broadcastSelection(response);
    touch();
    return json(response);
  };

  const handle = async (
    req: Request,
    pathnameOverride?: string,
    observation?: RequestObservation,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = pathnameOverride ?? url.pathname;
    if (observation) {
      // Attach the artifact so a mounted route's exit record carries it
      // (DF-1c). The host attaches; the record lifecycle (end) stays with
      // observeRequests.
      observation.attach({ artifact: paths.artifactPath });
      observationContext.enterWith(observation);
    }

    // The overlay bootstrap bundle is a public static asset. It must be
    // reachable from the sandboxed artifact iframe, which loads it cross-origin
    // (opaque origin -> Origin: null). Serving it BEFORE the Host/Origin gate
    // (with a CORS allow) lets the overlay mount; the control routes below still
    // reject null/cross-origin callers, so artifact scripts cannot reach them.
    if (pathname === "/__lucid/client.js") return serveBundleAsset("client.js", req);

    const headerCheck = validateHeaders(req, options.getPort());
    if (!headerCheck.ok) {
      recordRefusal({ _tag: "ForbiddenError", code: "FORBIDDEN" });
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
      return viewerResponse({
        session: paths.artifactPath,
        name: basename(paths.artifactPath),
        port: options.getPort(),
        version: await currentVersion(),
        base,
      });
    }
    // The chrome's own bundle + stylesheet. Unlike the overlay these stay
    // behind the Host/Origin gate: they are same-origin requests from Lucid's
    // viewer page, and nothing in the sandboxed artifact should reach them.
    if (pathname === "/__lucid/chrome.js") return serveBundleAsset("chrome.js", req);
    if (pathname === "/__lucid/chrome.css") return serveBundleAsset("chrome.css", req);
    if (pathname === "/__lucid/events") {
      const isAgent = url.searchParams.get("role") === "agent";
      // The browser upgrades (its six-per-origin HTTP pool is the whole reason
      // live.ts exists); `lucid wait`'s subscriber keeps the SSE wire. The
      // Host/Origin gate above has already run, which matters MORE here: a
      // WebSocket handshake is not subject to CORS at all.
      return wantsUpgrade(req)
        ? channel.handleUpgrade(req, options.upgrade, isAgent)
        : channel.sseResponse(isAgent);
    }
    if (pathname === "/__lucid/artifact") {
      const html = await readFile(paths.currentHtml, "utf8").catch(() => "");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", ...noStore },
      });
    }
    if (pathname === "/__lucid/state") {
      // The whole viewer-state assembly (fold + attendant + presence +
      // resume + context/selection) lives behind src/core/viewer-state.ts.
      // agentsListening is a THUNK so it is read at response-build time,
      // not when the request started (D-006).
      return json(await viewerState(paths, { agentsListening: () => agentSubscribers.size }));
    }
    if (pathname === "/__lucid/sessions" && req.method === "GET") {
      const root = artifactCheckout(paths);
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
    if (pathname === "/__lucid/bind" && req.method === "POST") return handleBind(req);
    if (pathname === "/__lucid/context" && req.method === "POST") return handleContext(req);
    if (pathname === "/__lucid/resolve" && req.method === "POST") {
      const result = decodeResolve();
      if (!result.ok) {
        recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
        return json({ error: result.error }, 400);
      }
      await serverAppend([result.value]);
      return json({ ok: true });
    }
    // Clearing is a boundary the fold understands, not a delete: the log keeps
    // every event and the viewer derives its record from what follows.
    if (pathname === "/__lucid/clear" && req.method === "POST") {
      const result = decodeClear();
      if (!result.ok) {
        recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
        return json({ error: result.error }, 400);
      }
      await serverAppend([result.value]);
      return json({ ok: true });
    }
    if (pathname === "/__lucid/reopen" && req.method === "POST") {
      const result = decodeReopen();
      if (!result.ok) {
        recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
        return json({ error: result.error }, 400);
      }
      await serverAppend([result.value]);
      return json({ ok: true });
    }
    if (pathname === "/__lucid/end" && req.method === "POST") {
      const result = decodeEnd();
      if (!result.ok) {
        recordRefusal({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
        return json({ error: result.error }, 400);
      }
      await serverAppend([result.value]);
      queueMicrotask(() => options.onEnded());
      return json({ ok: true });
    }

    // ---- browser auto-probes: serve the viewer's own icon, never warn ----
    // These are requested by the browser/crawler, not referenced by the
    // artifact, so a 404 here is not a missing artifact asset (no warning).
    if (pathname === "/favicon.ico") return serveBundleAsset("favicon.ico", req);
    if (BROWSER_PROBES.has(pathname)) {
      return new Response(null, { status: 204 });
    }

    // ---- artifact document route (fixed; D-054) ----
    if (pathname === "/") {
      return artifactDocumentResponse(paths, base, new URL(req.url).origin);
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
  // Artifact change detection (the debounced fs.watch, the stat-gated 1s
  // poll, and the coalescing commit queue) lives behind
  // src/server/artifact-watch.ts. onCommitted broadcasts the actually-appended
  // event; onWarning surfaces a typed refusal. The presence sweep stays here
  // (it is broadcast presence, not change detection).
  const artifactWatch = createArtifactWatch(paths, {
    debounceMs,
    onCommitted: broadcast,
    onWarning: (warning) => broadcastWarning(warning.code, warning.message),
  });

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
      if (channel.size() === 0) return; // nobody is looking
      try {
        const state = await sessionState(paths);
        const target = await artifactAttendant(paths, state.sessionHistory);
        const presence = attendantPresenceOf(await presenceFor(target, paths.artifactDir));
        // Deduped on the serialized form: the projection is rebuilt every
        // sweep, so only its content can say whether anything changed.
        const frame = JSON.stringify(presence);
        if (frame === lastPresence) return;
        lastPresence = frame;
        broadcastFrame({ event: "presence", data: presence });
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
    if (channel.size() > 0) return false;
    const appended = await appendIfStatus(paths, "active", [{ t: "session_suspended" }]);
    if (appended.length > 0) {
      // Broadcast like serverAppend would: a subscriber that squeezed in
      // after the size check above still learns of the suspend before the
      // owner closes the streams (and its reconnect heals the log).
      for (const e of appended) broadcast(e);
      touch();
      return true;
    }
    return channel.size() === 0;
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
      const state = await sessionState(paths);
      if (state.status !== "suspended") return;
      const appended = await appendIfStatus(paths, "suspended", [
        { t: "session_resumed", segment: state.segment },
      ]);
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
    artifactWatch.stop();
    channel.stop();
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
    lastActivityAt: () => (channel.size() > 0 ? Date.now() : lastActivity),
    agentsListening: () => agentSubscribers.size,
    warn: broadcastWarning,
  };
};
