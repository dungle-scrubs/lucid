import { css, html, LitElement } from "lit";
import type { Anchor } from "../../src/anchors/anchor.ts";
import {
  isOverlayMessage,
  type ChromeMessage,
  type PayloadAnnotationLike,
} from "../shared/protocol.ts";

interface Config {
  readonly mode: string;
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
}

interface MessageImage {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

interface ConversationMessage {
  readonly role: "human" | "agent";
  readonly text: string;
  readonly at: string;
  readonly images?: readonly MessageImage[];
}

/** A pasted image staged in the composer (not yet sent). */
interface PastedImage {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  /** Local object URL for the composer thumbnail. */
  readonly url: string;
}

interface QueuedAnnotation {
  readonly id: string;
  readonly target: Anchor;
  readonly note: string;
}

interface WarningItem {
  readonly code: string;
  readonly message: string;
}

interface AgentQuestion {
  readonly id: string;
  readonly text: string;
  readonly ref?: string;
  readonly answered: boolean;
  readonly answer?: string;
}

interface DiffHunk {
  readonly id: string;
  readonly kind: "added" | "removed" | "changed";
  readonly label: string;
  readonly anchor: Anchor;
}

interface DiffData {
  readonly base: number;
  readonly current: number;
  readonly changed: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly mergedHtml: string;
}

const HUNK_SIGN: Readonly<Record<DiffHunk["kind"], string>> = {
  added: "+",
  removed: "−",
  changed: "~",
};

const uuid = (): string => crypto.randomUUID();

/** True when a key event is destined for a text field, so window-level
 *  shortcuts can leave the caret alone. */
const isTextEntry = (node: EventTarget | undefined): boolean =>
  node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement;

const DEFAULT_CHROME_WIDTH = 384;
const CHROME_MIN_WIDTH = 320;
const DIVIDER_WIDTH = 5;
const CHROME_WIDTH_KEY = "lucid:chromeWidth";

const readStoredWidth = (): number => {
  try {
    const raw = localStorage.getItem(CHROME_WIDTH_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 300 ? n : DEFAULT_CHROME_WIDTH;
  } catch {
    return DEFAULT_CHROME_WIDTH;
  }
};

const targetLabel = (target: Anchor): string =>
  target.kind === "element"
    ? target.snippet.replace(/\s+/g, " ").slice(0, 80)
    : `“${target.snippet.slice(0, 80)}”`;

/**
 * The chrome (RFC §1). The Lucid-owned viewer parent: composer, composer queue,
 * conversation log, annotation list, and controls, wrapped around an isolated
 * `<iframe>` surface. Owns all server I/O (SSE + POSTs); the overlay only does
 * DOM targeting and talks to the chrome via postMessage.
 */
export class LucidChrome extends LitElement {
  static properties = {
    annotations: { state: true },
    messages: { state: true },
    version: { state: true },
    reviewResolved: { state: true },
    pendingTarget: { state: true },
    composerNote: { state: true },
    queue: { state: true },
    editingId: { state: true },
    editDraft: { state: true },
    sending: { state: true },
    messageDraft: { state: true },
    pastedImages: { state: true },
    newerVersion: { state: true },
    warnings: { state: true },
    status: { state: true },
    chromeWidth: { state: true },
    dragging: { state: true },
    hoveredId: { state: true },
    diffMode: { state: true },
    diffData: { state: true },
    diffIndex: { state: true },
    diffBase: { state: true },
    revertWhy: { state: true },
    lightboxImages: { state: true },
    lightboxIndex: { state: true },
    questions: { state: true },
    answerDrafts: { state: true },
  };

  declare annotations: PayloadAnnotationLike[];
  declare messages: ConversationMessage[];
  declare version: number;
  declare reviewResolved: boolean;
  declare pendingTarget: Anchor | null;
  declare composerNote: string;
  declare queue: QueuedAnnotation[];
  declare editingId: string | null;
  declare editDraft: string;
  declare sending: boolean;
  declare messageDraft: string;
  declare pastedImages: PastedImage[];
  declare newerVersion: number | null;
  declare warnings: WarningItem[];
  declare status: string;
  declare chromeWidth: number;
  declare dragging: boolean;
  declare hoveredId: string | null;
  declare diffMode: boolean;
  declare diffData: DiffData | null;
  declare diffIndex: number;
  declare diffBase: number;
  declare revertWhy: string;
  declare lightboxImages: readonly MessageImage[] | null;
  declare lightboxIndex: number;
  declare questions: AgentQuestion[];
  declare answerDrafts: Record<string, string>;

  private dragStartX = 0;
  private dragStartW = 0;
  private pointerDown = false;
  private moved = false;

  private config: Config;
  private iframe: HTMLIFrameElement | null = null;
  private overlayReady = false;
  private pendingSwapHtml: string | null = null;
  private source: EventSource | null = null;

  constructor() {
    super();
    this.config = (window as unknown as { __LUCID__: Config }).__LUCID__;
    this.annotations = [];
    this.messages = [];
    this.version = this.config.version;
    this.reviewResolved = false;
    this.pendingTarget = null;
    this.composerNote = "";
    this.queue = [];
    this.editingId = null;
    this.editDraft = "";
    this.sending = false;
    this.messageDraft = "";
    this.pastedImages = [];
    this.newerVersion = null;
    this.warnings = [];
    this.status = "active";
    this.chromeWidth = readStoredWidth();
    this.dragging = false;
    this.hoveredId = null;
    this.diffMode = false;
    this.diffData = null;
    this.diffIndex = 0;
    this.diffBase = Math.max(1, this.config.version - 1);
    this.revertWhy = "";
    this.lightboxImages = null;
    this.lightboxIndex = 0;
    this.questions = [];
    this.answerDrafts = {};
  }

  // ---- agent questions ------------------------------------------------------

  private async sendAnswer(q: AgentQuestion): Promise<void> {
    const text = (this.answerDrafts[q.id] ?? "").trim();
    if (text.length === 0) return;
    try {
      await this.api("/__lucid/answer", { id: uuid(), questionId: q.id, text });
      const drafts = { ...this.answerDrafts };
      delete drafts[q.id];
      this.answerDrafts = drafts; // clear only after the answer is recorded
    } catch {
      this.warn("Your answer didn't send - it's kept here, try again.");
    }
  }

  private setAnswerDraft(id: string, value: string): void {
    this.answerDrafts = { ...this.answerDrafts, [id]: value };
  }

  private focusQuestionRef(ref?: string): void {
    if (ref) this.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: ref });
  }

  // ---- image lightbox -------------------------------------------------------

  private openLightbox(images: readonly MessageImage[], index: number): void {
    this.lightboxImages = images;
    this.lightboxIndex = index;
  }

  private closeLightbox(): void {
    this.lightboxImages = null;
  }

  private lightboxStep(delta: number): void {
    const images = this.lightboxImages;
    if (!images || images.length === 0) return;
    this.lightboxIndex = (this.lightboxIndex + delta + images.length) % images.length;
  }

  private readonly onLightboxKey = (e: KeyboardEvent): void => {
    if (!this.lightboxImages) return;
    if (e.key === "Escape") this.closeLightbox();
    else if (e.key === "ArrowRight") this.lightboxStep(1);
    else if (e.key === "ArrowLeft") this.lightboxStep(-1);
  };

  // ---- diff / change view (RFC §8) ------------------------------------------

  private async enterDiff(base = this.diffBase): Promise<void> {
    try {
      const res = await this.api(`/__lucid/diff?base=${base}`);
      const data = (await res.json()) as DiffData;
      this.diffData = data;
      this.diffBase = base;
      this.diffMode = true;
      this.diffIndex = 0;
      this.toOverlay({ source: "lucid-chrome", type: "diff-show", html: data.mergedHtml });
      if (data.hunks.length > 0) {
        requestAnimationFrame(() => this.gotoHunk(0));
      }
    } catch {
      /* diff unavailable */
    }
  }

  private async exitDiff(): Promise<void> {
    this.diffMode = false;
    this.revertWhy = "";
    const html = await this.api("/__lucid/artifact")
      .then((r) => r.text())
      .catch(() => null);
    if (html !== null) this.toOverlay({ source: "lucid-chrome", type: "swap", html });
    this.pushHighlights();
  }

  private gotoHunk(index: number): void {
    const hunks = this.diffData?.hunks ?? [];
    if (hunks.length === 0) return;
    const i = ((index % hunks.length) + hunks.length) % hunks.length;
    this.diffIndex = i;
    const hunk = hunks[i];
    if (hunk) this.toOverlay({ source: "lucid-chrome", type: "diff-goto", hunkId: hunk.id });
  }

  private async revertCurrentHunk(): Promise<void> {
    const hunk = this.diffData?.hunks[this.diffIndex];
    const why = this.revertWhy.trim();
    if (!hunk || why.length === 0) return;
    try {
      await this.api("/__lucid/revert", {
        id: uuid(),
        target: hunk.anchor,
        targetVersion: this.diffBase,
        why,
      });
      this.revertWhy = "";
    } catch {
      this.warn("The revert didn't send - your reason is kept, try again.");
    }
  }

  private readonly onDiffKey = (e: KeyboardEvent): void => {
    if (!this.diffMode) return;
    // Hunk navigation is a window listener, so it would otherwise steal arrows
    // from the caret and Escape from a composer while a text field has focus.
    // composedPath()[0] is the real target; e.target retargets to the host.
    if (isTextEntry(e.composedPath()[0])) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      this.gotoHunk(this.diffIndex + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      this.gotoHunk(this.diffIndex - 1);
    } else if (e.key === "Escape") {
      void this.exitDiff();
    }
  };

  // ---- resizable chrome (drag the divider) ---------------------------------

  // Pointer capture routes move/up to the divider even over the iframe, and we
  // never preventDefault on pointerdown, so the native dblclick still fires
  // (that powers double-click-to-fit). `dragging` is set immediately so
  // user-select:none (and an inert iframe) suppress text selection from the
  // first pixel; a movement threshold gates actual width changes so a plain
  // click/double-click does not nudge the width.
  private clearSelections(): void {
    try {
      window.getSelection()?.removeAllRanges();
      this.iframe?.contentWindow?.getSelection()?.removeAllRanges();
    } catch {
      /* cross-origin or unsupported; ignore */
    }
  }

  private readonly onDragStart = (e: PointerEvent): void => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.dragStartX = e.clientX;
    this.dragStartW = this.chromeWidth;
    this.pointerDown = true;
    this.moved = false;
    this.dragging = true;
    this.clearSelections();
  };

  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.pointerDown) return;
    if (!this.moved && Math.abs(e.clientX - this.dragStartX) < 4) return;
    this.moved = true;
    this.clearSelections();
    const max = Math.max(CHROME_MIN_WIDTH, window.innerWidth - DIVIDER_WIDTH - 200);
    const next = this.dragStartW + (e.clientX - this.dragStartX);
    this.chromeWidth = Math.max(CHROME_MIN_WIDTH, Math.min(max, next));
  };

  private readonly onDragEnd = (e: PointerEvent): void => {
    this.pointerDown = false;
    this.dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (this.moved) {
      this.moved = false;
      this.persistWidth();
    }
  };

  /** Measured width of the artifact's content column inside the iframe. */
  private contentWidth(): number {
    const doc = this.iframe?.contentDocument;
    if (!doc?.body) return 0;
    let w = 0;
    for (const child of Array.from(doc.body.children)) {
      const el = child as HTMLElement;
      if (el.id === "__lucid_overlay_root" || el.tagName === "SCRIPT") continue;
      w = Math.max(w, el.getBoundingClientRect().width);
    }
    return Math.round(w);
  }

  /**
   * Double-click: size the surface to exactly the content's max-width and give
   * the rest to the chat, keeping the chat at or above its minimum (D-055-style
   * "no wasted surface"). Falls back to the default if content can't be measured.
   */
  private readonly onDividerFit = (): void => {
    const cw = this.contentWidth();
    if (cw <= 0) {
      this.chromeWidth = DEFAULT_CHROME_WIDTH;
    } else {
      this.chromeWidth = Math.max(CHROME_MIN_WIDTH, window.innerWidth - DIVIDER_WIDTH - cw);
    }
    this.persistWidth();
  };

  private persistWidth(): void {
    try {
      localStorage.setItem(CHROME_WIDTH_KEY, String(this.chromeWidth));
    } catch {
      /* storage unavailable; width simply resets next load */
    }
  }

  static styles = css`
    :host {
      display: block;
      height: 100vh;
      color: #e2e8f0;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      font-size: 13px;
    }
    .root {
      display: grid;
      height: 100vh;
    }
    .panel {
      display: flex;
      flex-direction: column;
      background: #11141b;
      overflow: hidden;
      min-width: 0;
    }
    .divider {
      background: #1f2530;
      cursor: col-resize;
      position: relative;
    }
    .divider::after {
      content: "";
      position: absolute;
      inset: 0 -3px;
    }
    .divider:hover,
    .divider.active {
      background: #d69e2e;
    }
    /* While dragging the divider, suppress text selection everywhere and make
       the surface iframe inert so the drag never starts/extends a selection. */
    .root.dragging {
      cursor: col-resize;
      user-select: none;
      -webkit-user-select: none;
    }
    .root.dragging iframe {
      pointer-events: none;
    }
    header {
      padding: 14px 16px;
      border-bottom: 1px solid #1f2530;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title { font-weight: 600; letter-spacing: 0.2px; }
    .title small { color: #7b8694; font-weight: 400; display: block; font-size: 11px; }
    .vtag {
      font-variant-numeric: tabular-nums;
      background: #1b2230;
      color: #9fb3c8;
      border-radius: 999px;
      padding: 2px 9px;
      font-size: 11px;
    }
    .scroll { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
    section h3 {
      margin: 0 0 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #6b7686;
    }
    .empty { color: #4d5666; font-style: italic; font-size: 12px; }
    .card {
      background: #171c25;
      border: 1px solid #232b38;
      border-radius: 8px;
      padding: 10px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .card + .card { margin-top: 8px; }
    .card.focused {
      border-color: #d69e2e;
      box-shadow: inset 0 0 0 1px #d69e2e;
    }
    [data-test="send-queue"] { margin-top: 12px; }
    .snippet {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #cbd5e0;
      background: #0d1016;
      border-radius: 5px;
      padding: 5px 7px;
      max-height: 56px;
      overflow: hidden;
      border-left: 2px solid #d69e2e;
    }
    .msg { display: flex; flex-direction: column; gap: 3px; }
    .msg + .msg { margin-top: 22px; padding-top: 16px; border-top: 1px solid #1b212c; }
    .msg .who { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; }
    .msg.human .who { color: #63b3ed; }
    .msg.agent .who { color: #68d391; }
    .msg .text { white-space: pre-wrap; line-height: 1.45; color: #d7deea; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .thumb {
      width: 88px; height: 66px; object-fit: cover;
      border-radius: 6px; border: 1px solid #2a3340; display: block;
    }
    .thumb-btn { all: unset; cursor: zoom-in; display: inline-block; border-radius: 6px; }
    .thumb-btn:hover .thumb { border-color: #cba85a; }
    .thumb-btn:focus-visible { outline: 2px solid #d69e2e; outline-offset: 2px; }
    /* Image lightbox */
    .lightbox {
      position: fixed; inset: 0; z-index: 100;
      background: rgba(8,9,12,0.9);
      display: flex; align-items: center; justify-content: center;
    }
    .lb-img {
      max-width: 90vw; max-height: 86vh; border-radius: 8px; background: #fff;
      box-shadow: 0 24px 70px -20px rgba(0,0,0,0.8);
    }
    .lb-close {
      position: absolute; top: 12px; right: 16px; font-size: 26px; line-height: 1;
      background: transparent; border: 0; color: #cfd8e3; cursor: pointer; padding: 6px 10px;
    }
    .lb-close:hover { color: #fff; }
    .lb-nav {
      position: absolute; top: 50%; transform: translateY(-50%);
      font-size: 34px; line-height: 1; background: rgba(0,0,0,0.4); border: 0;
      color: #e2e8f0; cursor: pointer; padding: 6px 16px; border-radius: 8px;
    }
    .lb-nav:hover { background: rgba(0,0,0,0.75); color: #fff; }
    .lb-prev { left: 18px; }
    .lb-next { right: 18px; }
    .lb-counter {
      position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
      color: #9fb3c8; font-variant-numeric: tabular-nums; font-size: 12px;
    }
    .lb-name {
      position: absolute; bottom: 36px; left: 50%; transform: translateX(-50%);
      color: #cbd5e0; font-size: 12px; max-width: 60vw;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .composer { display: flex; flex-direction: column; gap: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      background: #171c25; border: 1px solid #2a3340; border-radius: var(--radius-pill, 999px);
      padding: 3px 6px 3px 3px; max-width: 100%;
    }
    .chip-thumb { width: 22px; height: 22px; object-fit: cover; border-radius: 999px; }
    .chip-name {
      font-size: 11px; color: #cbd5e0; max-width: 150px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .chip-x {
      all: unset; cursor: pointer; color: #8b94a1; font-size: 14px; line-height: 1;
      padding: 0 3px; border-radius: 4px;
    }
    .chip-x:hover { color: #fbb6c2; background: #2a3340; }
    textarea, input.note {
      width: 100%;
      box-sizing: border-box;
      background: #0d1016;
      color: #e2e8f0;
      border: 1px solid #2a3340;
      border-radius: 6px;
      padding: 8px;
      font: inherit;
      resize: vertical;
    }
    textarea:focus, input.note:focus { outline: none; border-color: #3b82f6; }
    .row { display: flex; gap: 8px; align-items: center; }
    button {
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: 1px solid #2a3340;
      background: #1b2230;
      color: #cfd8e3;
      border-radius: 6px;
      padding: 3px 8px;
      cursor: pointer;
    }
    button:hover { background: #232c3c; }
    button.primary { background: #2563eb; border-color: #2563eb; color: white; }
    button.primary:hover { background: #1d4ed8; }
    button.good { background: #16794d; border-color: #16794d; color: white; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    /* Agent questions awaiting the human - anchored above the composer */
    .questions-section {
      border-top: 1px solid #1f2530;
      background: #0f1218;
      padding: 12px 14px 4px;
      max-height: 38vh;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .questions-section h3 { color: #cba85a; margin-top: 2px; }
    .qcard {
      background: #171c25; border: 1px solid #2a3340; border-left: 3px solid #cba85a;
      border-radius: 8px; padding: 10px 11px; margin-bottom: 8px;
      display: flex; flex-direction: column; gap: 7px;
    }
    .qcard.answered { border-left-color: #61714b; opacity: 0.85; }
    .qtext { font-weight: 500; color: #e8edf4; }
    .qinput { width: 100%; box-sizing: border-box; background: #0d1016; color: #e2e8f0;
      border: 1px solid #2a3340; border-radius: 6px; padding: 7px; font: inherit; resize: vertical; }
    .qinput:focus { outline: none; border-color: #cba85a; }
    .qanswer { font-size: 13px; color: #cfd8e3; }
    .qanswer .who { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: #e2a541; margin-right: 6px; }
    .pill { font-size: 10px; padding: 1px 7px; border-radius: 999px; }
    .pill.orphan { background: #5b2330; color: #fbb6c2; }
    .pill.resolved { background: #1f3a2c; color: #9ae6b4; }
    /* Number chip shared with the in-artifact marker badge, so a card and its
       spot on the surface read as the same numbered item. */
    .idxchip {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
      color: #1a202c; flex: none;
    }
    .idxchip.committed { background: rgba(214, 158, 46, 0.97); }
    .idxchip.queued { background: rgba(203, 168, 90, 0.95); border: 1px dashed rgba(110, 84, 28, 0.7); }
    footer { border-top: 1px solid #1f2530; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
    .surface { display: flex; flex-direction: column; background: #11141b; min-width: 0; }
    .surface-header {
      padding: 10px 16px; border-bottom: 1px solid #1f2530;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .surface-body { position: relative; flex: 1; min-height: 0; background: #fff; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .banner {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: #d69e2e;
      color: #1a202c;
      padding: 7px 14px;
      border-radius: 8px;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      z-index: 5;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .banner button { background: #1a202c; color: #fff; border: 0; padding: 4px 10px; }
    .resolved-bar { background: #16310f; color: #9ae6b4; padding: 8px 14px; border-bottom: 1px solid #1f2530; display:flex; justify-content:space-between; align-items:center;}
    .ghostbtn {
      font: inherit; font-weight: 600; font-size: 11px;
      background: transparent; color: #cba85a; border: 1px solid #4b4334;
      border-radius: 999px; padding: 2px 10px; cursor: pointer;
    }
    .ghostbtn:hover { background: #1b2230; border-color: #cba85a; }
    /* Diff navigator pinned to the surface */
    .diffbar {
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      max-width: calc(100% - 32px);
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      background: #11141b; color: #e2e8f0; border: 1px solid #2a3340;
      border-radius: 10px; padding: 7px 10px; z-index: 6;
      box-shadow: 0 8px 24px -10px rgba(0,0,0,0.6);
      font-size: 12px;
    }
    .diffbar select {
      font: inherit; font-size: 11px; background: #0d1016; color: #e2e8f0;
      border: 1px solid #2a3340; border-radius: 5px; padding: 2px 4px; max-width: 220px;
    }
    .diffbar-since { color: #9fb3c8; display: inline-flex; align-items: center; gap: 5px; }
    .diffbar-step { display: inline-flex; align-items: center; gap: 6px; }
    .diffbar-count { font-variant-numeric: tabular-nums; color: #cba85a; min-width: 42px; text-align: center; }
    .diffbar-none { color: #7b8593; font-style: italic; }
    .iconbtn {
      font: inherit; font-weight: 600; background: #1b2230; color: #cfd8e3;
      border: 1px solid #2a3340; border-radius: 6px; padding: 3px 9px; cursor: pointer;
    }
    .iconbtn:hover { background: #232c3c; }
    .iconbtn.done { background: #1f2530; }
    .diffbar-revert { display: inline-flex; align-items: center; gap: 6px; }
    .revert-why { width: 200px; font-size: 11px; padding: 4px 6px; }
    button.rust { background: #a4502f; border-color: #a4502f; color: #fff; font-weight: 600;
      border-radius: 6px; padding: 3px 8px; cursor: pointer; }
    button.rust:hover { background: #b85a35; }
    button.rust:disabled { opacity: 0.4; cursor: not-allowed; }
    .warn { color: #fbb6c2; font-size: 11px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
    window.addEventListener("keydown", this.onDiffKey);
    window.addEventListener("keydown", this.onLightboxKey);
    void this.bootstrap();
    this.subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("keydown", this.onDiffKey);
    window.removeEventListener("keydown", this.onLightboxKey);
    this.source?.close();
  }

  firstUpdated(): void {
    this.iframe = this.renderRoot.querySelector("iframe");
  }

  // ---- server I/O -----------------------------------------------------------

  private async api(path: string, body?: unknown): Promise<Response> {
    const isPost = body !== undefined;
    const init: RequestInit = {
      method: isPost ? "POST" : "GET",
      ...(isPost
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    };
    // POSTs retry with backoff so a brief server blip (e.g. a restart) doesn't
    // lose the submission; a persistent failure throws so the caller can keep
    // the user's input and surface an error.
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
  }

  private warn(message: string): void {
    this.warnings = [...this.warnings.slice(-4), { code: "SEND_FAILED", message }];
  }

  private async bootstrap(): Promise<void> {
    try {
      const res = await this.api("/__lucid/state");
      const state = (await res.json()) as {
        version: number;
        reviewResolved: boolean;
        annotations: PayloadAnnotationLike[];
        messages: { role: "human" | "agent"; text: string; at: string; images?: MessageImage[] }[];
        questions?: AgentQuestion[];
        status: string;
      };
      this.version = state.version;
      this.reviewResolved = state.reviewResolved;
      this.annotations = [...state.annotations];
      this.messages = state.messages.map((m) => ({
        role: m.role,
        text: m.text,
        at: m.at,
        ...(m.images ? { images: m.images } : {}),
      }));
      this.questions = [...(state.questions ?? [])];
      this.pushHighlights();
    } catch {
      // server may not be ready yet; SSE will fill in
    }
  }

  private subscribe(): void {
    const source = new EventSource("/__lucid/events");
    this.source = source;
    source.onmessage = (e) => this.onLogEvent(e.data);
    source.addEventListener("warning", (e) => {
      try {
        const w = JSON.parse((e as MessageEvent).data) as WarningItem;
        this.warnings = [...this.warnings.slice(-4), w];
      } catch {
        /* ignore */
      }
    });
  }

  private onLogEvent(data: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (ev.t) {
      case "annotation": {
        const id = ev.id as string;
        if (!this.annotations.some((a) => a.id === id)) {
          this.annotations = [
            ...this.annotations,
            {
              id,
              version: ev.version as number,
              resolved: true,
              target: ev.target as Anchor,
              note: ev.note as string,
              at: ev.at as string,
            },
          ];
          this.pushHighlights();
        }
        break;
      }
      case "prompt":
        this.messages = [
          ...this.messages,
          {
            role: "human",
            text: ev.text as string,
            at: ev.at as string,
            ...(Array.isArray(ev.images) ? { images: ev.images as MessageImage[] } : {}),
          },
        ];
        break;
      case "agent_reply":
        this.messages = [
          ...this.messages,
          { role: "agent", text: ev.text as string, at: ev.at as string },
        ];
        break;
      case "question":
        if (!this.questions.some((q) => q.id === ev.id)) {
          this.questions = [
            ...this.questions,
            {
              id: ev.id as string,
              text: ev.text as string,
              ref: ev.ref as string | undefined,
              answered: false,
            },
          ];
        }
        break;
      case "question_answered":
        this.questions = this.questions.map((q) =>
          q.id === (ev.questionId as string)
            ? { ...q, answered: true, answer: ev.text as string }
            : q,
        );
        break;
      case "review_resolved":
        this.reviewResolved = true;
        break;
      case "review_reopened":
        this.reviewResolved = false;
        break;
      case "version":
        void this.onNewVersion(ev.version as number);
        break;
      case "session_ended":
        this.status = "ended";
        break;
      case "session_suspended":
        this.status = "suspended";
        break;
      default:
        break;
    }
  }

  // ---- live reload (defer-until-committed; D-055) ---------------------------

  /** A started-but-unqueued note in the composer. Discardable, unlike the
   *  queue - which is only cleared by sending or removing card by card. */
  private hasComposerDraft(): boolean {
    return this.pendingTarget !== null && this.composerNote.trim().length > 0;
  }

  private hasUnsentDraft(): boolean {
    return this.queue.length > 0 || this.hasComposerDraft();
  }

  /** Name what is actually holding back the swap, so the banner never offers a
   *  discard for work that discarding cannot touch. */
  private deferralBlocker(): string {
    const n = this.queue.length;
    const queued = `send your ${n} queued annotation${n > 1 ? "s" : ""} to see it`;
    if (n > 0 && this.hasComposerDraft()) return `${queued}, or discard your draft`;
    if (n > 0) return queued;
    return "send or discard your draft";
  }

  private async onNewVersion(version: number): Promise<void> {
    const html = await this.api("/__lucid/artifact")
      .then((r) => r.text())
      .catch(() => null);
    if (html === null) return;
    if (this.hasUnsentDraft()) {
      this.pendingSwapHtml = html;
      this.newerVersion = version;
      return;
    }
    this.applySwap(html, version);
  }

  private applySwap(html: string, version: number): void {
    this.toOverlay({ source: "lucid-chrome", type: "swap", html });
    // The version the human was looking at becomes the diff base default.
    this.diffBase = this.version;
    this.version = version;
    this.newerVersion = null;
    this.pendingSwapHtml = null;
    // version changed -> resolved flags may change; refresh from server
    void this.bootstrap();
  }

  private applyDeferredSwapIfReady(): void {
    if (this.pendingSwapHtml !== null && this.newerVersion !== null && !this.hasUnsentDraft()) {
      this.applySwap(this.pendingSwapHtml, this.newerVersion);
    }
  }

  // ---- overlay bridge -------------------------------------------------------

  private readonly onMessage = (e: MessageEvent): void => {
    if (!isOverlayMessage(e.data)) return;
    if (e.data.type === "ready") {
      this.overlayReady = true;
      this.pushHighlights();
    } else if (e.data.type === "target-picked") {
      this.pendingTarget = e.data.anchor;
      this.pushHighlights();
      this.scrollPanelToBottom();
    } else if (e.data.type === "annotation-hover") {
      this.hoveredId = e.data.id;
    } else if (e.data.type === "annotation-activate") {
      this.hoveredId = e.data.id;
      this.scrollCardIntoView(e.data.id);
    }
  };

  /** Bring an annotation card to the top of the chrome scroll area if off-screen. */
  private scrollCardIntoView(id: string): void {
    requestAnimationFrame(() => {
      const scroll = this.renderRoot.querySelector(".scroll") as HTMLElement | null;
      const card = this.renderRoot.querySelector(
        `[data-annotation-id="${id}"]`,
      ) as HTMLElement | null;
      if (!scroll || !card) return;
      const sr = scroll.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const fullyVisible = cr.top >= sr.top && cr.bottom <= sr.bottom;
      if (!fullyVisible) {
        scroll.scrollTo({ top: scroll.scrollTop + (cr.top - sr.top) - 10, behavior: "smooth" });
      }
    });
  }

  /** Bring the active compose area (bottom of the panel) into view after a pick
   *  or a queue add, so new items appear where the eye is. */
  private scrollPanelToBottom(): void {
    void this.updateComplete.then(() => {
      const scroll = this.renderRoot.querySelector(".scroll") as HTMLElement | null;
      if (scroll) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
    });
  }

  private toOverlay(message: ChromeMessage): void {
    this.iframe?.contentWindow?.postMessage(message, "*");
  }

  private pushHighlights(): void {
    if (!this.overlayReady) return;
    this.toOverlay({
      source: "lucid-chrome",
      type: "highlight",
      annotations: this.annotations,
      queued: this.queue.map((q) => ({ id: q.id, target: q.target })),
      pending: this.pendingTarget,
    });
  }

  // ---- composer actions -----------------------------------------------------

  private addToQueue(): void {
    if (!this.pendingTarget || this.composerNote.trim().length === 0) return;
    this.queue = [
      ...this.queue,
      { id: uuid(), target: this.pendingTarget, note: this.composerNote.trim() },
    ];
    this.pendingTarget = null;
    this.composerNote = "";
    this.pushHighlights();
    this.scrollPanelToBottom();
  }

  private discardPending(): void {
    this.pendingTarget = null;
    this.composerNote = "";
    this.applyDeferredSwapIfReady();
    this.pushHighlights();
  }

  private removeQueued(id: string): void {
    if (this.editingId === id) this.cancelEdit();
    this.queue = this.queue.filter((q) => q.id !== id);
    this.applyDeferredSwapIfReady();
    this.pushHighlights();
  }

  /** Open a queued annotation's note for editing. Only one card edits at a
   *  time, so an already-open edit is folded back in first. */
  private beginEdit(id: string): void {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    if (!this.commitEdit()) return;
    this.editingId = id;
    this.editDraft = item.note;
    void this.updateComplete.then(() => {
      const box = this.renderRoot.querySelector(
        `[data-annotation-id="${id}"] textarea`,
      ) as HTMLTextAreaElement | null;
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    });
  }

  private cancelEdit(): void {
    this.editingId = null;
    this.editDraft = "";
  }

  /** Fold an open edit back into the queue. The note is the whole point of an
   *  annotation, so an empty draft is refused rather than silently dropped;
   *  callers check the result before proceeding. */
  private commitEdit(): boolean {
    if (this.editingId === null) return true;
    const note = this.editDraft.trim();
    if (note.length === 0) return false;
    const id = this.editingId;
    this.queue = this.queue.map((q) => (q.id === id ? { ...q, note } : q));
    this.cancelEdit();
    return true;
  }

  private readonly onEditKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.cancelEdit();
      return;
    }
    this.onSubmitKey(e, () => this.commitEdit());
  };

  private async sendQueue(): Promise<void> {
    if (!this.commitEdit()) {
      this.warn("Finish editing the queued annotation first - a note can't be empty.");
      return;
    }
    const sent = new Set<string>();
    this.sending = true; // freeze the queue: an item edited mid-flight would send its old note
    try {
      for (const q of this.queue) {
        await this.api("/__lucid/annotation", {
          id: q.id,
          version: this.version,
          target: q.target,
          note: q.note,
        });
        sent.add(q.id); // ids are idempotent, so a retry of a sent one is safe
      }
    } catch {
      this.warn("Some annotations didn't send - they're kept in the queue, try again.");
    }
    this.sending = false;
    // Reconcile against live state, not a pre-send snapshot: a fresh annotation
    // can still be queued while requests are in flight, so drop exactly what
    // sent and keep the rest.
    this.queue = this.queue.filter((q) => !sent.has(q.id));
    this.applyDeferredSwapIfReady();
    this.pushHighlights();
  }

  private async sendMessage(): Promise<void> {
    const text = this.messageDraft.trim();
    const images = this.pastedImages.map(({ id, name, file }) => ({ id, name, file }));
    if (text.length === 0 && images.length === 0) return;
    try {
      await this.api("/__lucid/message", { id: uuid(), text, refs: [], images });
      for (const img of this.pastedImages) URL.revokeObjectURL(img.url);
      this.messageDraft = "";
      this.pastedImages = []; // clear only after the message is recorded
    } catch {
      this.warn("Your message didn't send - it's kept here, try again.");
    }
  }

  // ---- pasted images --------------------------------------------------------

  private readonly onComposerPaste = async (e: ClipboardEvent): Promise<void> => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter((it) => it.type.startsWith("image/"));
    if (imageItems.length === 0) return; // let normal text paste proceed
    e.preventDefault();
    for (const it of imageItems) {
      const file = it.getAsFile();
      if (!file) continue;
      try {
        const res = await fetch("/__lucid/asset", {
          method: "POST",
          headers: { "content-type": file.type, "x-lucid-filename": file.name || "pasted" },
          body: file,
        });
        if (!res.ok) continue;
        const meta = (await res.json()) as { id: string; name: string; file: string };
        this.pastedImages = [
          ...this.pastedImages,
          { id: meta.id, name: meta.name, file: meta.file, url: URL.createObjectURL(file) },
        ];
      } catch {
        /* upload failed; skip this image */
      }
    }
  };

  private removePasted(id: string): void {
    const gone = this.pastedImages.find((p) => p.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    this.pastedImages = this.pastedImages.filter((p) => p.id !== id);
  }

  private async resolveReview(): Promise<void> {
    try {
      await this.api("/__lucid/resolve", {});
    } catch {
      this.warn("Couldn't record the approval - try again.");
    }
  }

  private async reopenReview(): Promise<void> {
    try {
      await this.api("/__lucid/reopen", {});
    } catch {
      this.warn("Couldn't reopen the review - try again.");
    }
  }

  /** Enter submits; Shift+Enter inserts a newline. Ignores IME composition. */
  private readonly onSubmitKey = (e: KeyboardEvent, action: () => void): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      action();
    }
  };

  // ---- render ---------------------------------------------------------------

  render() {
    const orphans = this.annotations.filter((a) => !a.resolved);
    const located = this.annotations.filter((a) => a.resolved);
    return html`
      <div
        class=${`root${this.dragging ? " dragging" : ""}`}
        style=${`grid-template-columns:${this.chromeWidth}px ${DIVIDER_WIDTH}px 1fr`}
      >
      <div class="panel">
        ${
          this.reviewResolved
            ? html`<div class="resolved-bar"><span>✓ Review approved</span><button @click=${this.reopenReview}>Reopen review</button></div>`
            : null
        }

        <div class="scroll">
          <section>
            <h3>Annotations (${this.annotations.length})</h3>
            ${this.annotations.length === 0 ? html`<div class="empty">No feedback sent yet.</div>` : null}
            ${located.map(
              (a, i) => html`
                <div
                  class=${`card${this.hoveredId === a.id ? " focused" : ""}`}
                  data-test="annotation"
                  data-annotation-id=${a.id}
                  @mouseenter=${() => this.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: a.id })}
                  @mouseleave=${() => this.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: "" })}
                >
                  <div class="row" style="justify-content:space-between">
                    <span class="idxchip committed">${i + 1}</span>
                    <span class="pill resolved">located · v${a.version}</span>
                  </div>
                  <div class="snippet">${targetLabel(a.target)}</div>
                  <div>${a.note}</div>
                </div>
              `,
            )}
            ${
              orphans.length > 0
                ? html`
                  <h3 style="margin-top:8px">Orphaned (${orphans.length})</h3>
                  ${orphans.map(
                    (a) => html`
                      <div class="card" data-test="orphan">
                        <span class="pill orphan">orphaned · v${a.version}</span>
                        <div class="snippet">${targetLabel(a.target)}</div>
                        <div>${a.note}</div>
                      </div>
                    `,
                  )}
                `
                : null
            }
          </section>

          <section>
            <h3>Conversation</h3>
            ${this.messages.length === 0 ? html`<div class="empty">No messages.</div>` : null}
            ${this.messages.map(
              (m) =>
                html`<div class="msg ${m.role}">
                  <span class="who">${m.role}</span>
                  ${m.text ? html`<span class="text">${m.text}</span>` : null}
                  ${
                    m.images && m.images.length > 0
                      ? html`<div class="thumbs">
                        ${m.images.map(
                          (img, i) =>
                            html`<button class="thumb-btn" title=${img.name} data-test="thumb" @click=${() => this.openLightbox(m.images ?? [], i)}>
                              <img class="thumb" src=${`/__lucid/asset/${img.file}`} alt=${img.name} />
                            </button>`,
                        )}
                      </div>`
                      : null
                  }
                </div>`,
            )}
          </section>

          ${
            this.warnings.length > 0
              ? html`<section><h3>Warnings</h3>${this.warnings.map((w) => html`<div class="warn">${w.code}: ${w.message}</div>`)}</section>`
              : null
          }

          ${
            this.queue.length > 0
              ? html`
                <section>
                  <h3>Queued (${this.queue.length})</h3>
                  ${this.queue.map(
                    (q, i) => html`
                      <div
                        class=${`card${this.hoveredId === q.id ? " focused" : ""}`}
                        data-annotation-id=${q.id}
                        @mouseenter=${() => this.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: q.id })}
                        @mouseleave=${() => this.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: "" })}
                      >
                        <div class="row" style="justify-content:flex-start">
                          <span class="idxchip queued">${i + 1}</span>
                        </div>
                        <div class="snippet">${targetLabel(q.target)}</div>
                        ${
                          this.editingId === q.id
                            ? html`
                              <textarea
                                rows="3"
                                data-test="edit-note"
                                placeholder="Edit this annotation… (Enter to save, Shift+Enter for a new line, Esc to cancel)"
                                .value=${this.editDraft}
                                @input=${(e: Event) => (this.editDraft = (e.target as HTMLTextAreaElement).value)}
                                @keydown=${this.onEditKey}
                              ></textarea>
                              <div class="row">
                                <button
                                  class="primary"
                                  data-test="save-edit"
                                  ?disabled=${this.editDraft.trim().length === 0}
                                  @click=${() => this.commitEdit()}
                                >Save</button>
                                <button data-test="cancel-edit" @click=${this.cancelEdit}>Cancel</button>
                              </div>
                            `
                            : html`
                              <div>${q.note}</div>
                              <div class="row">
                                <button data-test="edit-queued" ?disabled=${this.sending} @click=${() => this.beginEdit(q.id)}>Edit</button>
                                <button ?disabled=${this.sending} @click=${() => this.removeQueued(q.id)}>Remove</button>
                              </div>
                            `
                        }
                      </div>
                    `,
                  )}
                  <button class="primary" data-test="send-queue" ?disabled=${this.sending} @click=${this.sendQueue}>Send ${this.queue.length} annotation${this.queue.length > 1 ? "s" : ""}</button>
                </section>
              `
              : null
          }

          ${
            this.pendingTarget
              ? html`
                <section>
                  <h3>New annotation</h3>
                  <div class="card">
                    <div class="snippet">${targetLabel(this.pendingTarget)}</div>
                    <textarea
                      rows="3"
                      placeholder="What should change here? (Enter to queue, Shift+Enter for a new line)"
                      .value=${this.composerNote}
                      @input=${(e: Event) => (this.composerNote = (e.target as HTMLTextAreaElement).value)}
                      @keydown=${(e: KeyboardEvent) => this.onSubmitKey(e, () => this.addToQueue())}
                    ></textarea>
                    <div class="row">
                      <button class="primary" data-test="add-to-queue" @click=${this.addToQueue}>Add to queue</button>
                      <button data-test="discard" @click=${this.discardPending}>Discard</button>
                    </div>
                  </div>
                </section>
              `
              : html`<section><h3>New annotation</h3><div class="empty">Click an element or select text in the artifact to annotate it.</div></section>`
          }
        </div>

        ${this.renderQuestions()}

        <footer>
          <div class="composer">
            ${
              this.pastedImages.length > 0
                ? html`<div class="chips">
                  ${this.pastedImages.map(
                    (img) => html`<span class="chip" data-test="image-chip">
                      <img class="chip-thumb" src=${img.url} alt=${img.name} />
                      <span class="chip-name">${img.name}</span>
                      <button class="chip-x" title="Remove" @click=${() => this.removePasted(img.id)}>×</button>
                    </span>`,
                  )}
                </div>`
                : null
            }
            <textarea
              rows="2"
              placeholder="Message the agent, or paste an image… (Enter to send, Shift+Enter for a new line)"
              .value=${this.messageDraft}
              @input=${(e: Event) => (this.messageDraft = (e.target as HTMLTextAreaElement).value)}
              @paste=${this.onComposerPaste}
              @keydown=${(e: KeyboardEvent) => this.onSubmitKey(e, () => void this.sendMessage())}
            ></textarea>
          </div>
          <div class="row" style="justify-content:space-between">
            <button data-test="send-message" @click=${this.sendMessage}>Send message</button>
            ${
              this.reviewResolved
                ? null
                : html`<button class="good" data-test="approve" @click=${this.resolveReview}>Approve review</button>`
            }
          </div>
        </footer>
      </div>

      <div
        class=${`divider${this.dragging ? " active" : ""}`}
        @pointerdown=${this.onDragStart}
        @pointermove=${this.onDragMove}
        @pointerup=${this.onDragEnd}
        @dblclick=${this.onDividerFit}
        title="Drag to resize · double-click to fit the document"
      ></div>

      <div class="surface">
        <header class="surface-header">
          <div class="title">Lucid review<small>${this.config.name}</small></div>
          <div class="row" style="gap:6px">
            ${
              this.version > 1 && !this.diffMode
                ? html`<button class="ghostbtn" data-test="enter-diff" title="Show what changed" @click=${() => void this.enterDiff()}>changes</button>`
                : null
            }
            <div class="vtag" title="current artifact version">v${this.version}</div>
          </div>
        </header>
        <div class="surface-body">
          ${
            this.newerVersion !== null
              ? html`<div class="banner" data-test="newer-version">Newer version (v${this.newerVersion}) available · ${this.deferralBlocker()}${
                  this.hasComposerDraft()
                    ? html`<button data-test="discard-draft" @click=${this.discardPending}>Discard draft</button>`
                    : null
                }</div>`
              : null
          }
          ${this.diffMode ? this.renderDiffBar() : null}
          <!--
            sandbox=allow-scripts (deliberately WITHOUT allow-same-origin) gives
            the artifact iframe an opaque origin. The overlay still loads and
            runs (allow-scripts), assets still resolve by URL, and postMessage
            still works across the boundary - but artifact-authored scripts can
            no longer hit the same-origin control routes, since those are now
            cross-origin from the opaque iframe and rejected by both the browser
            and the server Host/Origin validation (security.ts). This is the
            script-isolation boundary CONTEXT.md defers (D-020).
          -->
          <iframe src="/" title="artifact surface" sandbox="allow-scripts"></iframe>
        </div>
      </div>
      </div>
      ${this.renderLightbox()}
    `;
  }

  private renderQuestions() {
    if (this.questions.length === 0) return null;
    const open = this.questions.filter((q) => !q.answered);
    const answered = this.questions.filter((q) => q.answered);
    return html`
      <section class="questions-section">
        <h3>Questions for you${open.length > 0 ? ` (${open.length})` : ""}</h3>
        ${open.map(
          (q) => html`
            <div class="qcard" data-test="question">
              <div
                class="qtext"
                style=${q.ref ? "cursor:pointer" : ""}
                @mouseenter=${() => this.focusQuestionRef(q.ref)}
              >${q.text}</div>
              <textarea
                class="qinput"
                rows="2"
                placeholder="Your answer… (Enter to send, Shift+Enter for a new line)"
                .value=${this.answerDrafts[q.id] ?? ""}
                @input=${(e: Event) => this.setAnswerDraft(q.id, (e.target as HTMLTextAreaElement).value)}
                @keydown=${(e: KeyboardEvent) => this.onSubmitKey(e, () => void this.sendAnswer(q))}
              ></textarea>
              <div class="row">
                <button
                  class="primary"
                  data-test="answer"
                  ?disabled=${(this.answerDrafts[q.id] ?? "").trim().length === 0}
                  @click=${() => void this.sendAnswer(q)}
                >Answer</button>
              </div>
            </div>
          `,
        )}
        ${answered.map(
          (q) => html`
            <div class="qcard answered" data-test="question-answered">
              <div class="qtext">${q.text}</div>
              <div class="qanswer"><span class="who">you</span> ${q.answer}</div>
            </div>
          `,
        )}
      </section>
    `;
  }

  private renderLightbox() {
    const images = this.lightboxImages;
    if (!images || images.length === 0) return null;
    const img = images[this.lightboxIndex];
    if (!img) return null;
    const multi = images.length > 1;
    return html`
      <div
        class="lightbox"
        data-test="lightbox"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.closeLightbox();
        }}
      >
        <button class="lb-close" title="Close (Esc)" @click=${() => this.closeLightbox()}>×</button>
        ${
          multi
            ? html`<button class="lb-nav lb-prev" data-test="lb-prev" title="Previous (←)" @click=${() => this.lightboxStep(-1)}>‹</button>`
            : null
        }
        <img class="lb-img" src=${`/__lucid/asset/${img.file}`} alt=${img.name} />
        ${
          multi
            ? html`<button class="lb-nav lb-next" data-test="lb-next" title="Next (→)" @click=${() => this.lightboxStep(1)}>›</button>`
            : null
        }
        ${multi ? html`<div class="lb-counter" data-test="lb-counter">${this.lightboxIndex + 1} / ${images.length}</div>` : null}
        <div class="lb-name">${img.name}</div>
      </div>
    `;
  }

  private renderDiffBar() {
    const data = this.diffData;
    const hunks = data?.hunks ?? [];
    const total = hunks.length;
    const current = hunks[this.diffIndex];
    const bases = Array.from({ length: this.version - 1 }, (_, i) => i + 1);
    return html`
      <div class="diffbar" data-test="diff-bar">
        <span class="diffbar-since">Changes since
          <select
            @change=${(e: Event) => void this.enterDiff(Number.parseInt((e.target as HTMLSelectElement).value, 10))}
          >
            ${bases.map((v) => html`<option value=${v} ?selected=${v === this.diffBase}>v${v}</option>`)}
          </select>
        </span>
        ${
          total === 0
            ? html`<span class="diffbar-none">no changes from v${this.diffBase}</span>`
            : html`
              <span class="diffbar-step">
                <button class="iconbtn" title="Previous change" @click=${() => this.gotoHunk(this.diffIndex - 1)}>◀</button>
                <span class="diffbar-count" data-test="diff-count">${this.diffIndex + 1} / ${total}</span>
                <button class="iconbtn" title="Next change" @click=${() => this.gotoHunk(this.diffIndex + 1)}>▶</button>
              </span>
              <select
                class="diffbar-jump"
                .value=${String(this.diffIndex)}
                @change=${(e: Event) => this.gotoHunk(Number.parseInt((e.target as HTMLSelectElement).value, 10))}
              >
                ${hunks.map(
                  (h, i) => html`<option value=${i}>${HUNK_SIGN[h.kind]} ${h.label}</option>`,
                )}
              </select>
              ${
                current
                  ? html`<span class="diffbar-revert">
                    <input
                      class="note revert-why"
                      placeholder=${`revert this to v${this.diffBase} - why?`}
                      .value=${this.revertWhy}
                      @input=${(e: Event) => (this.revertWhy = (e.target as HTMLInputElement).value)}
                      @keydown=${(e: KeyboardEvent) => this.onSubmitKey(e, () => void this.revertCurrentHunk())}
                    />
                    <button
                      class="rust"
                      data-test="revert"
                      ?disabled=${this.revertWhy.trim().length === 0}
                      @click=${() => void this.revertCurrentHunk()}
                    >Revert</button>
                  </span>`
                  : null
              }
            `
        }
        <button class="iconbtn done" data-test="diff-done" @click=${() => void this.exitDiff()}>Done</button>
      </div>
    `;
  }
}

export const mountChrome = (): void => {
  if (!customElements.get("lucid-chrome")) {
    customElements.define("lucid-chrome", LucidChrome);
  }
};
