import { createStore, type StoreApi } from "zustand/vanilla";
import { parseAnchor, type Anchor } from "../../src/anchors/anchor.ts";
import type {
  AgentWorking,
  AttendantPresence,
  AttendantRef,
  ContextUsage,
  HarnessInfo,
  SelectionState,
} from "../../src/protocol/wire.ts";
import type { PayloadAnnotationLike } from "../shared/protocol.ts";
import type { GroupDraft } from "./question-draft.ts";
import type {
  AgentQuestion,
  ConversationMessage,
  DiffData,
  MessageImage,
  OutboxMessage,
  PastedImage,
  QueuedAnnotation,
  SessionSummary,
  TimelineItem,
  WarningItem,
} from "./types.ts";

export const uuid = (): string => crypto.randomUUID();

/** The server rejects a longer list (MAX_ANCHORS in session-host.ts), so the
 *  chrome stops collecting at the same count rather than composing a draft
 *  that cannot send. */
export const MAX_PICK_TARGETS = 8;

/** Anchor identity for the cmd-click toggle: the same element captured twice
 *  yields the same JSON, so a repeat pick is recognized and removed. */
export const sameAnchor = (a: Anchor, b: Anchor): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** One cmd-click's effect on a collection: a new spot appends (up to the cap),
 *  a repeated spot leaves - the familiar multi-select toggle. */
export const toggleAnchor = (list: readonly Anchor[], anchor: Anchor): readonly Anchor[] => {
  const without = list.filter((a) => !sameAnchor(a, anchor));
  if (without.length < list.length) return without;
  return list.length >= MAX_PICK_TARGETS ? list : [...list, anchor];
};

/**
 * A session's identity as the store needs it. One instance of everything in
 * this module exists PER SESSION - the shell can hold many at once - so
 * nothing here may reach for module state or `window.__LUCID__` directly.
 */
export interface SessionConfig {
  /** Canonical artifact path = the session id. */
  readonly session: string;
  /** Artifact basename (display label). */
  readonly name: string;
  /** Artifact version at the time the viewer was served. */
  readonly version: number;
  /** URL prefix for this session's routes ("" or "/s/<id>"). */
  readonly base: string;
  /** Cap on the fatal-stream reconnect backoff, ms. Threaded from the server
   *  (LUCID_SSE_MAX_BACKOFF_MS) so a test that kills a stream is not billed
   *  the production 15s ceiling; absent means production behaviour. */
  readonly sseMaxBackoffMs?: number;
}

const SHOW_TARGETS_LEGACY_KEY = "lucid:showTargets";

/** The three fields an uploaded image travels as - what POSTs carry and what
 *  storage keeps. The composer's object URL is a page-lifetime handle and
 *  never leaves the page that minted it. */
export interface WireImage {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

/** Project staged images down to the wire shape. Three call sites (queue
 *  send, fork, persistence) each used to spell the destructuring by hand. */
export const toWireImages = (images: readonly WireImage[]): WireImage[] =>
  images.map(({ id, name, file }) => ({ id, name, file }));

const isOutboxImage = (v: unknown): v is WireImage => {
  const o = v as Record<string, unknown> | null;
  return typeof o?.id === "string" && typeof o.name === "string" && typeof o.file === "string";
};

/** A queued annotation as it sits in storage: the composer's object URL is a
 *  page-lifetime handle, so it is dropped on write and rebuilt from the
 *  uploaded asset's `file` on read - the same way sent images render. */
interface PersistedQueuedAnnotation {
  readonly id: string;
  readonly targets: readonly Anchor[];
  readonly note: string;
  readonly at: string;
  readonly images: readonly WireImage[];
}

/**
 * A stored anchor is validated by the server's OWN validator, so the two ends
 * cannot drift: anything `parseAnchor` would 400 - which the 4xx
 * short-circuit makes terminal - is refused at restore instead of rendered.
 * An earlier version accepted any non-null object on the theory that a stale
 * anchor degrades to an orphaned mark; measured otherwise: one forged
 * `{kind:"elephant"}` in storage threw in `AnnotationPart`'s unguarded
 * `snippet.replace` on EVERY load, taking the valid cards down with it, and
 * skip-not-delete meant it never healed.
 */
const isAnchorLike = (v: unknown): v is Anchor => !("error" in parseAnchor(v));

const isQueuedAnnotation = (v: unknown): v is PersistedQueuedAnnotation => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o?.id === "string" &&
    typeof o.note === "string" &&
    o.note.trim().length > 0 &&
    typeof o.at === "string" &&
    Array.isArray(o.targets) &&
    o.targets.length > 0 &&
    o.targets.every(isAnchorLike) &&
    Array.isArray(o.images) &&
    o.images.every(isOutboxImage)
  );
};

/** Storage is untrusted input (a stale schema, another tool's key, a truncated
 *  write), and the outbox drives POSTs - so every field is checked rather than
 *  cast. A malformed entry is dropped, never sent. */
const isOutboxMessage = (v: unknown): v is OutboxMessage => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o?.id === "string" &&
    typeof o.text === "string" &&
    typeof o.at === "string" &&
    typeof o.failed === "boolean" &&
    Array.isArray(o.images) &&
    o.images.every(isOutboxImage)
  );
};

/**
 * The localStorage-backed persistence for one session's own keys: undelivered
 * messages and the show-marks preference. Keyed by session id (decision: marks
 * are remembered per session; layout is the shell's).
 */
export interface SessionStorage {
  readonly readOutbox: () => OutboxMessage[];
  readonly persistOutboxMessage: (message: OutboxMessage, onFail: () => void) => void;
  readonly forgetOutboxMessage: (id: string) => void;
  /** Queued annotations from a previous page life. The queue persists for the
   *  same reason the outbox does (D-054): a reload - or a closed tab - must
   *  not destroy a note a human wrote and did not send. */
  readonly readQueue: () => QueuedAnnotation[];
  readonly persistQueuedItem: (item: QueuedAnnotation, onFail: () => void) => void;
  readonly forgetQueuedItem: (id: string) => void;
  readonly readShowTargets: () => boolean;
  readonly persistShowTargets: (on: boolean) => void;
}

export const createSessionStorage = (
  sessionKey: string,
  /** Re-addresses a restored thumbnail through the asset route - the object
   *  URL a queued image was staged with died with the page that made it. */
  assetUrl: (file: string) => string,
): SessionStorage => {
  /**
   * One storage key per undelivered message, namespaced by session.
   *
   * Per session, so two viewers on different artifacts never inherit each
   * other's messages. Per *message*, because the alternative - one key holding
   * the whole array - makes every write a read-modify-write that two tabs on
   * the same session will lose: tab B saves its array, silently erasing the
   * message tab A had just written. Independent keys make the writes disjoint,
   * so no tab can overwrite another's undelivered work.
   */
  const outboxPrefix = `lucid:outbox:${sessionKey}:`;
  const queuePrefix = `lucid:queue:${sessionKey}:`;
  const showTargetsKey = `lucid:showTargets:${sessionKey}`;

  /**
   * One persistence bucket: per-item keys under one prefix.
   *
   * The policy lives HERE, once, because it was written twice and the two
   * copies could drift on exactly the parts that matter:
   *
   * - A malformed entry is SKIPPED, never deleted - unreadable to us, but
   *   still the only copy of something a human wrote.
   * - Reads return authoring order (`at` ascending), the order work must
   *   reach the agent in.
   * - Writes guard real data, so a failure (quota, private mode) reports to
   *   the caller: the entry still lives in memory, but it will not survive a
   *   reload and the human is the only one who can act on that.
   * - Deletes are silent - nothing is at stake in a delete that no-ops.
   */
  const bucket = <T extends { readonly at: string }>(
    prefix: string,
    guard: (v: unknown) => v is T,
  ) => ({
    readAll: (): T[] => {
      try {
        const found: T[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key === null || !key.startsWith(prefix)) continue;
          try {
            const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "");
            if (guard(parsed)) found.push(parsed);
          } catch {
            /* not ours to interpret */
          }
        }
        return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      } catch {
        return [];
      }
    },
    write: (id: string, value: T, onFail: () => void): void => {
      try {
        localStorage.setItem(prefix + id, JSON.stringify(value));
      } catch {
        onFail();
      }
    },
    forget: (id: string): void => {
      try {
        localStorage.removeItem(prefix + id);
      } catch {
        /* storage unavailable; the entry was never written either */
      }
    },
  });

  const outbox = bucket(outboxPrefix, isOutboxMessage);
  const queue = bucket(queuePrefix, isQueuedAnnotation);

  /** Undelivered messages outlive the tab on purpose: the whole point is that
   *  hitting Enter can never destroy typing. */
  const readOutbox = (): OutboxMessage[] => outbox.readAll();
  const persistOutboxMessage = (message: OutboxMessage, onFail: () => void): void =>
    outbox.write(message.id, message, onFail);
  const forgetOutboxMessage = (id: string): void => outbox.forget(id);

  /** The invariant `target === targets[0]` is rebuilt rather than trusted:
   *  storage is one writer among many, and the pair travelling separately is
   *  exactly the drift the invariant exists to prevent. */
  const readQueue = (): QueuedAnnotation[] =>
    queue.readAll().flatMap((p) => {
      const target = p.targets[0];
      if (!target) return [];
      return [
        {
          id: p.id,
          target,
          targets: p.targets,
          note: p.note,
          at: p.at,
          images: p.images.map((img) => ({ ...img, url: assetUrl(img.file) })),
        },
      ];
    });

  /** Add or edit - same key either way. The composer's object URL is dropped
   *  on write and rebuilt from the uploaded asset on read. */
  const persistQueuedItem = (item: QueuedAnnotation, onFail: () => void): void => {
    const persisted: PersistedQueuedAnnotation = {
      id: item.id,
      targets: item.targets,
      note: item.note,
      at: item.at,
      images: toWireImages(item.images),
    };
    queue.write(item.id, persisted, onFail);
  };

  const forgetQueuedItem = (id: string): void => queue.forget(id);

  /** Annotation marks are the point of the surface, so they are on unless the
   *  human has explicitly turned them off before. Falls back to the pre-shell
   *  global key so an existing preference survives the per-session move. */
  const readShowTargets = (): boolean => {
    try {
      const own = localStorage.getItem(showTargetsKey);
      if (own !== null) return own !== "0";
      return localStorage.getItem(SHOW_TARGETS_LEGACY_KEY) !== "0";
    } catch {
      return true;
    }
  };

  const persistShowTargets = (on: boolean): void => {
    try {
      localStorage.setItem(showTargetsKey, on ? "1" : "0");
    } catch {
      /* storage unavailable; the toggle simply resets next load */
    }
  };

  return {
    readOutbox,
    persistOutboxMessage,
    forgetOutboxMessage,
    readQueue,
    persistQueuedItem,
    forgetQueuedItem,
    readShowTargets,
    persistShowTargets,
  };
};

export interface SessionState {
  annotations: PayloadAnnotationLike[];
  messages: ConversationMessage[];
  /** This session's own artifact path - the session identity, so the sessions
   *  list can tell which row is the one you are looking at. */
  session: string;
  version: number;
  reviewResolved: boolean;
  pendingTarget: Anchor | null;
  /** Every spot of the in-flight draft, in pick order. INVARIANT:
   *  `pendingTarget === pendingTargets[0] ?? null` - the single field stays
   *  authoritative for everything that predates cmd-collection (fork, the
   *  approve guard, old overlays), so every write updates both together. */
  pendingTargets: readonly Anchor[];
  composerNote: string;
  queue: QueuedAnnotation[];
  editingId: string | null;
  editDraft: string;
  sending: boolean;
  /** A feedback batch has been delivered and no agent has acked it yet - the
   *  window between the annotation landing in the log and the first `agent_ack`
   *  that opens `agentWorking`. Client-local, because the log has nothing new
   *  to show during it: set when a send lands at least one item, cleared the
   *  moment the agent speaks (a working window opens, or a version arrives). */
  awaitingAck: boolean;
  /** A fork POST is in flight. Freezes the composer and disables Fork so a
   *  double-click cannot mint a second fork id the shared dedupe can't catch. */
  forking: boolean;
  /** Stable id for the in-flight/failed fork, kept across an ambiguous failure
   *  so a manual retry reuses it (idempotent) rather than creating a twin. Reset
   *  on a new pick or discard. */
  forkId: string | null;
  pastedImages: PastedImage[];
  /** Messages submitted but not yet in the log, oldest first. Persisted, so a
   *  dead server - or a closed tab - cannot swallow what was typed. */
  outbox: OutboxMessage[];
  /** The outbox is being drained right now (freezes its per-card actions). */
  outboxSending: boolean;
  /** WHICH entry is in flight, so a retry disables its own button and no
   *  other. A single global flag left every card reading "SENDING…" - the one
   *  control a failed send leaves you, unusable. */
  outboxSendingId: string | null;
  newerVersion: number | null;
  warnings: WarningItem[];
  /** Neutral, transient confirmations (e.g. a fork was recorded). */
  notices: { id: string; message: string }[];
  status: string;
  /** Open "agent is working" window from the fold: set by the agent's ack on
   *  taking delivery, closed by its next output (version, reply, question). */
  agentWorking: AgentWorking | null;
  /** Agents currently blocked in `wait` on this session - someone is
   *  listening. Distinct from agentWorking: listening is presence before
   *  delivery, working is the window after it. */
  agentsListening: number;
  /** Who last took delivery (advisory sidecar), with the copy-paste command
   *  that resumes their conversation when the harness recorded one. Display
   *  data only: resuming is the human's act, in their terminal. */
  lastAttendant: AttendantRef | null;
  /** That conversation as it exists RIGHT NOW, when the harness lets us see
   *  it. `interactive` means a human has it open in a terminal, which changes
   *  what this panel is: a place to watch, not a place to drive from. Null =
   *  not open, or a harness with no such signal - the same thing here. */
  attendantPresence: AttendantPresence | null;
  /** A harness conversation exists that a turn could resume. False for an
   *  artifact nobody has attended - a hand-written or recovered document -
   *  where announcing "spawn mode" would promise a turn that can never run. */
  resumable: boolean;
  /** Last-reported context-window usage of the attending harness (its
   *  statusline posts it). Presence, like lastAttendant: null = no ring. */
  contextUsage: ContextUsage | null;
  /** The artifact's sticky model/effort: what every UNATTENDED turn runs on.
   *  Empty = nothing picked, so the harness CLI decides. */
  selection: SelectionState;
  /** The vocabulary those picks are made in, from the artifact's own harness
   *  recipe. Null = no recipe (or a server that predates the route), which is
   *  what suppresses the pickers entirely. */
  selectionInfo: HarnessInfo | null;
  /** SSE stream health. EventSource reconnects by itself, so this is a
   *  transient indicator, not an error the human has to act on. */
  live: boolean;
  /** Consecutive FATAL-stream reopen attempts (resets when a stream opens).
   *  Surfaced on the reconnecting pill as data-retries: the one place a
   *  human - or a test - can see the recovery loop actually looping. */
  streamRetries: number;
  /** Sibling sessions in this project, fetched lazily when the tab is first
   *  opened. Null means "not looked yet", which is distinct from "none found". */
  sessions: SessionSummary[] | null;
  sessionsLoading: boolean;
  /** Show the annotation marks on the surface. Remembered per session. */
  showTargets: boolean;
  /** Every `data-lucid-id` in the current artifact, published by the overlay.
   *  Null until the first report: a section permalink renders as a live chip
   *  while null (optimistic) or present, and degrades to plain text once the
   *  set is known and the id is absent. */
  sectionIds: readonly string[] | null;
  hoveredId: string | null;
  diffMode: boolean;
  diffData: DiffData | null;
  diffIndex: number;
  diffBase: number;
  /** A past version being viewed read-only in the surface, or null for the live
   *  current artifact. Distinct from diffMode: this shows a whole snapshot as it
   *  was, not a diff against it. */
  viewingVersion: number | null;
  revertWhy: string;
  lightboxImages: readonly MessageImage[] | null;
  lightboxIndex: number;
  questions: AgentQuestion[];
  /** The drawer's in-progress answer per asked question (D11): selections,
   *  custom text, reasons, deferrals and the active tab. Lives here, not in the
   *  component, so lowering the drawer - or backgrounding the whole session -
   *  cannot lose a draft. */
  questionDrafts: Record<string, GroupDraft>;
  /** The asks that were outstanding when the human lowered the drawer (Escape /
   *  the close button). A LATER question - one not in this list - raises the
   *  drawer again, because dismissing one ask is not a standing refusal to be
   *  asked. Empty means the drawer is not lowered. */
  questionDrawerDismissed: readonly string[];
  /** A pinned artifact region attached to a question's answer, by question id. */
  answerAnchors: Record<string, Anchor>;
  /** Every pinned region per answer, in pick order (shift+cmd collects more
   *  than one). INVARIANT: `answerAnchors[id] === answerAnchorLists[id][0]`,
   *  kept the same way as pendingTarget/pendingTargets. */
  answerAnchorLists: Record<string, readonly Anchor[]>;
  /** Images staged on a question's answer, by question id. */
  answerImages: Record<string, PastedImage[]>;
  /** Count of in-flight answer-image uploads per question; submission waits on
   *  it so a just-picked image is never dropped by the send race. */
  answerUploading: Record<string, number>;
  /** The question currently awaiting an artifact pick, or null. While set, the
   *  next overlay target-pick attaches to that answer instead of the composer. */
  answerPickFor: string | null;
}

export type SessionStore = StoreApi<SessionState>;

/** The one spelling of "the composer holds queueable work": a pick, and a
 *  note that is more than whitespace. This pair was being re-derived inline
 *  at every gate that cares (the queue guard, the send-all fold, the button's
 *  disabled state) - and a rule spelled seven ways is a rule that drifts. */
export const hasComposerDraft = (
  s: Pick<SessionState, "pendingTarget" | "composerNote">,
): boolean => s.pendingTarget !== null && s.composerNote.trim().length > 0;

export const createSessionStore = (config: SessionConfig, storage: SessionStorage): SessionStore =>
  createStore<SessionState>(() => ({
    annotations: [],
    messages: [],
    session: config.session,
    version: config.version,
    reviewResolved: false,
    pendingTarget: null,
    pendingTargets: [],
    composerNote: "",
    queue: storage.readQueue(),
    editingId: null,
    editDraft: "",
    sending: false,
    awaitingAck: false,
    forking: false,
    forkId: null,
    pastedImages: [],
    outbox: storage.readOutbox(),
    outboxSending: false,
    outboxSendingId: null,
    newerVersion: null,
    warnings: [],
    notices: [],
    status: "active",
    agentWorking: null,
    agentsListening: 0,
    lastAttendant: null,
    attendantPresence: null,
    resumable: false,
    contextUsage: null,
    selection: {},
    selectionInfo: null,
    live: true,
    streamRetries: 0,
    sessions: null,
    sessionsLoading: false,
    showTargets: storage.readShowTargets(),
    sectionIds: null,
    hoveredId: null,
    diffMode: false,
    diffData: null,
    diffIndex: 0,
    diffBase: Math.max(1, config.version - 1),
    viewingVersion: null,
    revertWhy: "",
    lightboxImages: null,
    lightboxIndex: 0,
    questions: [],
    questionDrafts: {},
    questionDrawerDismissed: [],
    answerAnchors: {},
    answerAnchorLists: {},
    answerImages: {},
    answerUploading: {},
    answerPickFor: null,
  }));

/** The session's user-facing notifications, bound to its own store. */
export interface Notify {
  /** Capped: EventSource reconnects on its own and can report the same outage
   *  repeatedly, so an unbounded list would grow state and DOM all through it.
   *  The one way a warning enters the list, so the cap and the id cannot be
   *  skipped by a caller appending directly (the SSE `warning` frame did, and
   *  grew without bound). */
  readonly pushWarning: (code: string, message: string) => void;
  readonly warn: (message: string) => void;
  /** A neutral, transient confirmation (distinct from a warning) - e.g.
   *  "forked". Capped like warnings so it never grows unbounded; carries a
   *  stable id so repeated identical messages still render as distinct rows. */
  readonly notice: (message: string) => void;
}

export const createNotify = (store: SessionStore): Notify => {
  const pushWarning = (code: string, message: string): void =>
    store.setState((s) => ({
      warnings: [...s.warnings.slice(-4), { id: crypto.randomUUID(), code, message }],
    }));
  return {
    pushWarning,
    warn: (message) => pushWarning("SEND_FAILED", message),
    notice: (message) =>
      store.setState((s) => ({
        notices: [...s.notices.slice(-2), { id: crypto.randomUUID(), message }],
      })),
  };
};

/**
 * The review record: annotations and messages in one `at`-ordered stream.
 *
 * A plain function, not a zustand selector: it builds a new array every call,
 * and a selector that never returns a referentially-equal value re-renders on
 * every store read. Callers memoize it on the two slices it reads.
 *
 * The number comes from `located` order first, because that is how the overlay
 * numbers its badges - sorting must never renumber a card away from its mark.
 *
 * Orphans stay in the record at the moment they were written. Acting on an
 * annotation is what orphans it - revise the text a note points at and its
 * anchor stops resolving - so filing orphans elsewhere moved a note out of
 * sequence exactly when it had been answered, stranding the reply above the
 * question it answered.
 *
 * A question enters the record ONLY once answered, as one question+answer item
 * placed at the ANSWER moment (D14). An outstanding question is not history -
 * it is work, and it lives in the drawer until it is settled; a card for it up
 * here would drift ever further above the reply it eventually produced.
 */
/** The presence facts the delivered-waiting line reads, named so the choice
 *  below is a table a test can state as data rather than a rendered component. */
export interface AwaitPresence {
  /** A human has the conversation open in a terminal (`attendantPresence.interactive`). */
  readonly interactive: boolean;
  /** Agents blocked in `wait` on this session (`agentsListening`). */
  readonly listening: number;
  /** The hub attends AND a harness session exists to resume (`attend && resumable`). */
  readonly spawnable: boolean;
  /** The attending harness's name, for the interactive line. */
  readonly harness: string;
}

/**
 * What to show in the working slot AFTER a feedback send and BEFORE the agent's
 * first ack - the window the log cannot narrate because nothing new is in it
 * yet. The wording is keyed on presence so it promises a response only when one
 * is actually coming: `transient` lines expect an imminent ack (a shimmer),
 * while the last line is a standing fact - nothing is attending, and delivery
 * will sit until someone does. This is the same distinction `ListenerLine`
 * makes BEFORE a send; this carries it through the send-to-ack gap.
 */
export const deliveredWaiting = (p: AwaitPresence): { text: string; transient: boolean } => {
  if (p.interactive) return { text: `Delivered to ${p.harness} in the terminal`, transient: true };
  if (p.listening > 0) return { text: "Delivered — waiting for the agent…", transient: true };
  if (p.spawnable) return { text: "Delivered — starting a turn…", transient: true };
  return { text: "Delivered — nothing is watching yet", transient: false };
};

export const buildTimeline = (
  annotations: readonly PayloadAnnotationLike[],
  messages: readonly ConversationMessage[],
  queue: readonly QueuedAnnotation[],
  questions: readonly AgentQuestion[] = [],
): TimelineItem[] => {
  let located = 0;
  const sentIds = new Set(annotations.map((a) => a.id));
  return [
    ...annotations.map((annotation) => ({
      kind: "annotation" as const,
      // Authorship time when known: an annotation queued at 8:50 and sent at
      // 8:54 happened at 8:50, and must not leapfrog the messages in between.
      at: annotation.authoredAt ?? annotation.at,
      // Only a located anchor takes a number: the badge exists to match a mark
      // on the surface, and an orphan has no mark. Counting them would shift
      // every later card off its own badge.
      index: annotation.resolved ? ++located : null,
      annotation,
    })),
    // Unsent queue items hold their place in the record from the moment they
    // were written - the same instant their sent form will occupy.
    // CONTINUES the located count: a queued note is the next number, not a
    // second number 1. Restarting the count put two "1" badges on the same
    // element and two cards labelled "1" in the panel.
    //
    // A queued item whose id ALREADY appears in `annotations` is dropped
    // here, because this function is where the two id-spaces are joined and
    // therefore the only place the "one id, one entry" invariant can be
    // enforced against every writer. A queued item sends under its own id,
    // so between its POST landing and `sendQueue` filtering the queue the
    // same id is in both lists - and two entries sharing an id make
    // assistant-ui's MessageRepository throw, unmounting the whole viewer to
    // a blank page (measured; every unsent note lost with it). The sent form
    // wins: it is the one the log has.
    ...queue
      .filter((q) => !sentIds.has(q.id))
      .map((q, i) => ({
        kind: "queued" as const,
        at: q.at,
        index: located + i + 1,
        id: q.id,
      })),
    ...messages.map((message) => ({ kind: "message" as const, at: message.at, message })),
    // `answeredAt` is the answer's own moment; older logs (and any server that
    // predates the field) fall back to the ask time rather than vanishing.
    ...questions
      .filter((q) => q.answered)
      .map((question) => ({
        kind: "question" as const,
        at: question.answeredAt ?? question.at ?? "",
        question,
      })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};

/** Pull image files out of a paste, ignoring a normal text paste. */
export const imagesFromPaste = (e: ClipboardEvent | React.ClipboardEvent): readonly File[] =>
  Array.from(("clipboardData" in e ? e.clipboardData : null)?.items ?? [])
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
