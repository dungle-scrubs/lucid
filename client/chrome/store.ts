import { createStore, type StoreApi } from "zustand/vanilla";
import type { Anchor } from "../../src/anchors/anchor.ts";
import type { AgentWorking, AttendantRef, ContextUsage } from "../../src/protocol/wire.ts";
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
}

const SHOW_TARGETS_LEGACY_KEY = "lucid:showTargets";

const isOutboxImage = (v: unknown): v is { id: string; name: string; file: string } => {
  const o = v as Record<string, unknown> | null;
  return typeof o?.id === "string" && typeof o.name === "string" && typeof o.file === "string";
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
  readonly readShowTargets: () => boolean;
  readonly persistShowTargets: (on: boolean) => void;
}

export const createSessionStorage = (sessionKey: string): SessionStorage => {
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
  const outboxKey = (id: string): string => `${outboxPrefix}${id}`;
  const showTargetsKey = `lucid:showTargets:${sessionKey}`;

  /** Undelivered messages from a previous page life (this tab's or another's).
   *  They outlive the tab on purpose: the whole point is that hitting Enter can
   *  never destroy typing. Restored in authoring order, which is the order they
   *  must reach the agent in. */
  const readOutbox = (): OutboxMessage[] => {
    try {
      const found: OutboxMessage[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === null || !key.startsWith(outboxPrefix)) continue;
        try {
          const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "");
          // A malformed entry is skipped, not deleted: it is unreadable to us
          // but it is still the only copy of something a human typed.
          if (isOutboxMessage(parsed)) found.push(parsed);
        } catch {
          /* not ours to interpret */
        }
      }
      return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    } catch {
      return [];
    }
  };

  /** Write one undelivered message to storage. Unlike the other persisters this
   *  one guards real data, so a failure (quota, private mode) is reported to
   *  the caller: the entry still lives in memory, but it will not survive a
   *  reload and the human is the only one who can act on that. */
  const persistOutboxMessage = (message: OutboxMessage, onFail: () => void): void => {
    try {
      localStorage.setItem(outboxKey(message.id), JSON.stringify(message));
    } catch {
      onFail();
    }
  };

  /** Drop one message from storage: it reached the log, or the human discarded
   *  it. Silent on failure - there is nothing at stake in a delete that no-ops. */
  const forgetOutboxMessage = (id: string): void => {
    try {
      localStorage.removeItem(outboxKey(id));
    } catch {
      /* storage unavailable; the entry was never written either */
    }
  };

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
  composerNote: string;
  queue: QueuedAnnotation[];
  editingId: string | null;
  editDraft: string;
  sending: boolean;
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
  /** Last-reported context-window usage of the attending harness (its
   *  statusline posts it). Presence, like lastAttendant: null = no ring. */
  contextUsage: ContextUsage | null;
  /** SSE stream health. EventSource reconnects by itself, so this is a
   *  transient indicator, not an error the human has to act on. */
  live: boolean;
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

export const createSessionStore = (config: SessionConfig, storage: SessionStorage): SessionStore =>
  createStore<SessionState>(() => ({
    annotations: [],
    messages: [],
    session: config.session,
    version: config.version,
    reviewResolved: false,
    pendingTarget: null,
    composerNote: "",
    queue: [],
    editingId: null,
    editDraft: "",
    sending: false,
    forking: false,
    forkId: null,
    pastedImages: [],
    outbox: storage.readOutbox(),
    outboxSending: false,
    newerVersion: null,
    warnings: [],
    notices: [],
    status: "active",
    agentWorking: null,
    agentsListening: 0,
    lastAttendant: null,
    contextUsage: null,
    live: true,
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
export const buildTimeline = (
  annotations: readonly PayloadAnnotationLike[],
  messages: readonly ConversationMessage[],
  queue: readonly QueuedAnnotation[],
  questions: readonly AgentQuestion[] = [],
): TimelineItem[] => {
  let located = 0;
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
    ...queue.map((q, i) => ({ kind: "queued" as const, at: q.at, index: i + 1, id: q.id })),
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
