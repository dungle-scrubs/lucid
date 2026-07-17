import { create } from "zustand";
import type { Anchor } from "../../src/anchors/anchor.ts";
import type { AgentWorking, AttendantRef } from "../../src/protocol/wire.ts";
import type { PayloadAnnotationLike } from "../shared/protocol.ts";
import type {
  AgentQuestion,
  Config,
  ConversationMessage,
  DiffData,
  MessageImage,
  PastedImage,
  QueuedAnnotation,
  SessionSummary,
  TimelineItem,
  WarningItem,
} from "./types.ts";

export const uuid = (): string => crypto.randomUUID();

const config = (): Config => (window as unknown as { __LUCID__: Config }).__LUCID__;

const CHROME_WIDTH_KEY = "lucid:chromeWidth";
const SHOW_TARGETS_KEY = "lucid:showTargets";
const SIDEBAR_OPEN_KEY = "lucid:sidebarOpen";
export const DEFAULT_CHROME_WIDTH = 384;
export const CHROME_MIN_WIDTH = 320;

const readStoredWidth = (): number => {
  try {
    const raw = localStorage.getItem(CHROME_WIDTH_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 300 ? n : DEFAULT_CHROME_WIDTH;
  } catch {
    return DEFAULT_CHROME_WIDTH;
  }
};

/** Annotation marks are the point of the surface, so they are on unless the
 *  human has explicitly turned them off before. */
const readStoredShowTargets = (): boolean => {
  try {
    return localStorage.getItem(SHOW_TARGETS_KEY) !== "0";
  } catch {
    return true;
  }
};

/** The review panel is the reason the viewer exists, so it starts open unless
 *  the human closed it last time. */
const readStoredSidebarOpen = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

interface LucidState {
  annotations: PayloadAnnotationLike[];
  messages: ConversationMessage[];
  /** This viewer's own artifact path - the session identity, so the sessions
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
  pastedImages: PastedImage[];
  newerVersion: number | null;
  warnings: WarningItem[];
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
  /** SSE stream health. EventSource reconnects by itself, so this is a
   *  transient indicator, not an error the human has to act on. */
  live: boolean;
  chromeWidth: number;
  /** Panel open/closed. Closing collapses it out of flow, so the artifact
   *  reflows to full width rather than being covered. */
  sidebarOpen: boolean;
  /** Which face of the panel is showing: the review, or the project's other
   *  sessions. */
  sidebarTab: "chat" | "sessions";
  /** Sibling sessions in this project, fetched lazily when the tab is first
   *  opened. Null means "not looked yet", which is distinct from "none found". */
  sessions: SessionSummary[] | null;
  sessionsLoading: boolean;
  showTargets: boolean;
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
  answerDrafts: Record<string, string>;
}

const initial: LucidState = {
  annotations: [],
  messages: [],
  session: config().session,
  version: config().version,
  reviewResolved: false,
  pendingTarget: null,
  composerNote: "",
  queue: [],
  editingId: null,
  editDraft: "",
  sending: false,
  pastedImages: [],
  newerVersion: null,
  warnings: [],
  status: "active",
  agentWorking: null,
  agentsListening: 0,
  lastAttendant: null,
  live: true,
  chromeWidth: readStoredWidth(),
  sidebarOpen: readStoredSidebarOpen(),
  sidebarTab: "chat",
  sessions: null,
  sessionsLoading: false,
  showTargets: readStoredShowTargets(),
  hoveredId: null,
  diffMode: false,
  diffData: null,
  diffIndex: 0,
  diffBase: Math.max(1, config().version - 1),
  viewingVersion: null,
  revertWhy: "",
  lightboxImages: null,
  lightboxIndex: 0,
  questions: [],
  answerDrafts: {},
};

export const useLucid = create<LucidState>(() => initial);

export const set = useLucid.setState;
export const get = useLucid.getState;

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
 */
export const buildTimeline = (
  annotations: readonly PayloadAnnotationLike[],
  messages: readonly ConversationMessage[],
  queue: readonly QueuedAnnotation[],
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
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};

/** Capped: EventSource reconnects on its own and can report the same outage
 *  repeatedly, so an unbounded list would grow state and DOM all through it. */
export const warn = (message: string): void =>
  set((s) => ({ warnings: [...s.warnings.slice(-4), { code: "SEND_FAILED", message }] }));

export const api = async (path: string, body?: unknown): Promise<Response> => {
  const isPost = body !== undefined;
  const init: RequestInit = {
    method: isPost ? "POST" : "GET",
    ...(isPost
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  };
  // POSTs retry with backoff so a brief server blip (e.g. a restart) doesn't
  // lose the submission - every mutation carries a client-minted idempotent id,
  // so a retry of one that landed is safe. A persistent failure throws so the
  // caller can keep the human's input and surface an error.
  const attempts = isPost ? 4 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(path, init);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastErr ?? new Error(`request to ${path} failed`);
};

/** What `POST /__lucid/asset` returns: the server-decided identity of a stored blob. */
export interface UploadedAsset {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

/**
 * Upload a blob to the session's pasted store. The one implementation of the
 * upload protocol (content-type + x-lucid-filename headers, raw body) - the
 * annotation composer and the message composer both route through it. The
 * bytes must land before the event referencing them does, because the agent
 * reads them off disk. Throws on failure so each caller keeps its own recovery.
 */
export const uploadAsset = async (file: File): Promise<UploadedAsset> => {
  const res = await fetch("/__lucid/asset", {
    method: "POST",
    headers: { "content-type": file.type, "x-lucid-filename": file.name || "pasted" },
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  return (await res.json()) as UploadedAsset;
};

/** Upload a pasted blob and stage it for the annotation composer. */
export const uploadPaste = async (file: File): Promise<PastedImage | null> => {
  try {
    const meta = await uploadAsset(file);
    return { ...meta, url: URL.createObjectURL(file) };
  } catch {
    warn("That image didn't upload - try again.");
    return null;
  }
};

/** Pull image files out of a paste, ignoring a normal text paste. */
export const imagesFromPaste = (e: ClipboardEvent | React.ClipboardEvent): readonly File[] =>
  Array.from(("clipboardData" in e ? e.clipboardData : null)?.items ?? [])
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);

export const persistWidth = (w: number): void => {
  try {
    localStorage.setItem(CHROME_WIDTH_KEY, String(w));
  } catch {
    /* storage unavailable; width simply resets next load */
  }
};

export const persistShowTargets = (on: boolean): void => {
  try {
    localStorage.setItem(SHOW_TARGETS_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable; the toggle simply resets next load */
  }
};

export const persistSidebarOpen = (open: boolean): void => {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* storage unavailable; the panel simply reopens next load */
  }
};
