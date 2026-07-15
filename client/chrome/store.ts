import { create } from "zustand";
import type { Anchor } from "../../src/anchors/anchor.ts";
import type { PayloadAnnotationLike } from "../shared/protocol.ts";
import type {
  AgentQuestion,
  Config,
  ConversationMessage,
  DiffData,
  MessageImage,
  PastedImage,
  QueuedAnnotation,
  TimelineItem,
  WarningItem,
} from "./types.ts";

export const uuid = (): string => crypto.randomUUID();

const config = (): Config => (window as unknown as { __LUCID__: Config }).__LUCID__;

const CHROME_WIDTH_KEY = "lucid:chromeWidth";
const SHOW_TARGETS_KEY = "lucid:showTargets";
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

interface LucidState {
  annotations: PayloadAnnotationLike[];
  messages: ConversationMessage[];
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
  /** SSE stream health. EventSource reconnects by itself, so this is a
   *  transient indicator, not an error the human has to act on. */
  live: boolean;
  chromeWidth: number;
  showTargets: boolean;
  hoveredId: string | null;
  diffMode: boolean;
  diffData: DiffData | null;
  diffIndex: number;
  diffBase: number;
  revertWhy: string;
  lightboxImages: readonly MessageImage[] | null;
  lightboxIndex: number;
  questions: AgentQuestion[];
  answerDrafts: Record<string, string>;
}

const initial: LucidState = {
  annotations: [],
  messages: [],
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
  live: true,
  chromeWidth: readStoredWidth(),
  showTargets: readStoredShowTargets(),
  hoveredId: null,
  diffMode: false,
  diffData: null,
  diffIndex: 0,
  diffBase: Math.max(1, config().version - 1),
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
 */
export const buildTimeline = (
  annotations: readonly PayloadAnnotationLike[],
  messages: readonly ConversationMessage[],
): TimelineItem[] => {
  const located = annotations.filter((a) => a.resolved);
  return [
    ...located.map((annotation, i) => ({
      kind: "annotation" as const,
      at: annotation.at,
      index: i + 1,
      annotation,
    })),
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

/**
 * Upload a pasted blob and stage it. Shared by the annotation composer and the
 * message composer: the bytes must land before the event referencing them does,
 * because the agent reads them off disk.
 */
export const uploadPaste = async (file: File): Promise<PastedImage | null> => {
  try {
    const res = await fetch("/__lucid/asset", {
      method: "POST",
      headers: { "content-type": file.type, "x-lucid-filename": file.name || "pasted" },
      body: file,
    });
    if (!res.ok) throw new Error(String(res.status));
    const meta = (await res.json()) as { id: string; name: string; file: string };
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
