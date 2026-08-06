import { multiTargets, type StateResponse } from "../../src/protocol/wire.ts";
import { LUCID_ROUTES } from "../../src/protocol/routes.ts";
import type { OutlineMotionPreference } from "../shared/artifact-outline.ts";
import type { ChromeMessage } from "../shared/protocol.ts";
import { createChromeArtifactOutline, type OutlinePort } from "./artifact-outline-session.ts";
import {
  claimPendingOutlineChannel,
  discardPendingOutlineChannel,
  subscribeOutlineChannels,
} from "./outline-channel.ts";
import { annotationFocused, blocksVersionSwap, type SessionStore, unsentWork } from "./store.ts";
import { currentTheme } from "./theme.ts";
import type { Transport } from "./transport.ts";

/**
 * A session's side of the surface: the one place that talks to the overlay
 * (postMessage into the sandboxed artifact iframe) and syncs folded state from
 * the server. One instance per session - the iframe element is attached by
 * whichever shell view is currently showing this session, and everything else
 * (overlay readiness, the deferred swap, the bootstrap sequence) is state of
 * this session alone, never shared across tabs.
 */
export interface Surface {
  /** The shell registers this session's artifact iframe here on mount (and
   *  detaches with null). Attach carries no readiness of its own - readiness
   *  belongs to the ELEMENT (see markOverlayReady), so detaching and
   *  re-attaching the same live iframe keeps its running overlay. */
  readonly attach: (el: HTMLIFrameElement | null) => void;
  /** Register the one parent-owned rectangle future surface controls may use.
   * Callers measure this slot, never the independent notices above it. */
  readonly attachOutlineSlot: (el: HTMLDivElement | null) => void;
  readonly outlineSlotRect: () => DOMRect | null;
  /** Request a fresh bounded projection using the current frame and safe slot. */
  readonly requestOutlineLayout: () => boolean;
  /** Only the foreground session may retain or accept outline state. */
  readonly setOutlineActive: (active: boolean) => void;
  /** Suspend proof while parent chrome is moving the artifact frame. */
  readonly setOutlineGeometryMoving: (source: "divider" | "drawer", moving: boolean) => void;
  readonly activateOutline: (key: string, motion: OutlineMotionPreference) => boolean;
  /** The overlay signalled `ready` (or the iframe finished loading, which
   *  implies the overlay module ran - a missed one-shot `ready` must not leave
   *  the surface unpainted). */
  readonly markOverlayReady: () => void;
  /** True when a postMessage source is this session's own iframe. The window
   *  `message` handler must check this: any frame can forge an overlay-shaped
   *  payload, and under tabs a stale surface must not mutate another
   *  session's state. */
  readonly ownsSource: (source: MessageEventSource | null) => boolean;
  /** This session's own artifact frame rect in the parent viewport, or null
   *  when no iframe is attached. The copy Popover translates an in-iframe
   *  release point (posted by the overlay) into parent-viewport coordinates
   *  by adding this rect's origin; the parent cannot read the opaque-origin
   *  selection, and it cannot anchor the Popover without the frame's position. */
  readonly frameRect: () => DOMRect | null;
  readonly toOverlay: (message: ChromeMessage) => void;
  /** Replace the artifact DOM. ALWAYS arms the outline revision barrier so the
   *  outline re-proofs. Every swap, diff-show, version view and version exit
   *  goes through this - no caller may replace artifact DOM without it. */
  readonly showHtml: (html: string, options?: { revision?: number; mode?: "diff-show" }) => void;
  /** Light a mark in place (scroll: false) or bring it into view (scroll: true). */
  readonly emphasize: (id: string, scroll: boolean) => void;
  /** Scroll to a section (pulse: false) or flash it in place (pulse: true). */
  readonly revealSection: (lucidId: string, pulse: boolean) => void;
  readonly gotoHunk: (hunkId: string) => void;
  readonly requestSections: () => void;
  readonly measure: () => void;
  readonly setTheme: (theme: "dark" | "light") => void;
  readonly ping: (nonce: string) => void;
  /** Arm the outline revision barrier and return its number. Every
   *  DOM-replacing message (swap, diff-show) must carry one so the outline
   *  re-proofs against the new document. */
  readonly prepareRevision: () => number;
  readonly pushHighlights: () => void;
  readonly applyDeferredSwapIfReady: () => void;
  readonly bootstrap: () => Promise<void>;
  /** A lifecycle frame just moved this session's status. Bootstraps in flight
   *  are older than that news by definition and stop carrying a lifecycle of
   *  their own (see `lifecycleSeq`). */
  readonly noteLifecycle: () => void;
  /** Live reload, deferred until the human's unsent work is gone (D-055): a
   *  new artifact invalidates the anchors that work is written against. */
  readonly onNewVersion: (version: number) => Promise<void>;
  /** Release the private outline channel and its module-level subscription. */
  readonly dispose: () => void;
}

/**
 * Drop the ids the payload now reports delivered, and return null once none
 * remain. The server already derives an item's `delivered` state from
 * `deliveredThroughSeq`, so this reads that rather than keeping a second,
 * cruder copy of the same fact - which is what the boolean was.
 *
 * An id the payload does not mention at all is KEPT: a send whose item has
 * not appeared in the fold yet is still outstanding, and dropping it would
 * clear the line before the agent had seen anything.
 */
export const clearDelivered = (
  waiting: ReadonlySet<string> | null,
  payload: StateResponse,
): ReadonlySet<string> | null => {
  if (!waiting || waiting.size === 0) return null;
  const delivered = new Set<string>();
  for (const a of payload.annotations) if (a.delivered) delivered.add(a.id);
  for (const m of payload.messages) if (m.id && m.delivered) delivered.add(m.id);
  const left = [...waiting].filter((id) => !delivered.has(id));
  return left.length > 0 ? new Set(left) : null;
};

export const createSurface = (store: SessionStore, transport: Transport): Surface => {
  const get = store.getState;
  const set = store.setState;

  let iframeEl: HTMLIFrameElement | null = null;
  let detachedIframeEl: HTMLIFrameElement | null = null;
  let outlineSlotEl: HTMLDivElement | null = null;
  let outlineSlotObserver: ResizeObserver | null = null;
  const outlineGeometryMotions = new Set<"divider" | "drawer">();
  /**
   * The element whose overlay has announced itself. Readiness is a fact about
   * an ELEMENT, not this controller: a boolean here got wiped by a
   * detach/re-attach of the same live iframe, whose overlay never re-announces
   * (`ready` and `load` are both one-shot) - killing highlights silently and
   * permanently. Ready means "the attached element is the announced one".
   */
  let readyEl: HTMLIFrameElement | null = null;
  let pendingSwapHtml: string | null = null;
  /**
   * Bootstraps are fired from SSE frames, so several can be in flight at once.
   * Only the newest may land: an older snapshot arriving late would roll state
   * back over a message that has since been applied. A failure leaves state
   * alone rather than half-applying.
   */
  let bootstrapSeq = 0;
  /**
   * How many lifecycle frames have landed. `bootstrapSeq` orders bootstraps
   * against each other; this orders a bootstrap against the LIVE stream, which
   * is a different race and used not to exist - frames were the only writer of
   * `status`, and this snapshot now carries one too.
   *
   * A content event fires a bootstrap; while it is in flight `session_ended`
   * arrives and the tab goes to "ended"; the response, computed before that
   * append, still says "active" and would put a dead session back on screen
   * as a live one - reopen withheld, a send offered against nothing.
   */
  let lifecycleSeq = 0;

  const finiteInset = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);
  const outlineSlotRect = (): DOMRect | null => outlineSlotEl?.getBoundingClientRect() ?? null;
  const ownsSource = (source: MessageEventSource | null): boolean =>
    iframeEl !== null && source === iframeEl.contentWindow;
  const frameRect = (): DOMRect | null => iframeEl?.getBoundingClientRect() ?? null;
  const outlineLayoutAvailable = (): boolean => iframeEl !== null && outlineSlotEl !== null;
  const effectiveOutlineLayoutAvailable = (): boolean =>
    outlineLayoutAvailable() && outlineGeometryMotions.size === 0;
  const outline = createChromeArtifactOutline({
    getState: () => get(),
    measureLayout: () => {
      if (iframeEl === null) return null;
      const slotRect = outlineSlotRect();
      if (slotRect === null) return null;
      const frameRect = iframeEl.getBoundingClientRect();
      return {
        preferredWidth: finiteInset(slotRect.width),
        safeInsets: {
          bottom: finiteInset(frameRect.bottom - slotRect.bottom),
          right: finiteInset(frameRect.right - slotRect.right),
          top: finiteInset(slotRect.top - frameRect.top),
        },
      };
    },
    setState: (patch) => set(patch),
  });
  const acceptOutlinePort = (source: MessageEventSource, port: OutlinePort) => {
    if (!ownsSource(source)) return "unowned" as const;
    outline.acceptPort(port);
    return "handled" as const;
  };
  const unsubscribeOutlineChannels = subscribeOutlineChannels(acceptOutlinePort);

  const toOverlay = (message: ChromeMessage): void => {
    iframeEl?.contentWindow?.postMessage(message, "*");
  };

  const overlayReady = (): boolean => iframeEl !== null && iframeEl === readyEl;

  const pushHighlights = (): void => {
    if (!overlayReady()) return;
    const s = get();
    // A historical snapshot is read mode by definition (viewVersion): the
    // current record was not written against that DOM. The guard lives HERE
    // because the mark toggles (crosshair, sent-marks default, a card's link)
    // stay clickable while a snapshot is up, and each of them pushes - one
    // unguarded push would paint today's annotations onto yesterday's paper.
    if (s.viewingVersion !== null) {
      toOverlay({
        source: "lucid-chrome",
        type: "highlight",
        annotations: [],
        queued: [],
        pending: null,
        showTargets: false,
      });
      return;
    }
    toOverlay({
      source: "lucid-chrome",
      type: "highlight",
      annotations: s.annotations,
      // `targets` only with two or more, the wire's one shape per arity: the
      // type declares it absent on a singleton, so presence may be read as
      // "multi-target" without also checking the length.
      queued: s.queue.map((q) => ({
        id: q.id,
        target: q.target,
        ...(multiTargets(q.targets) ? { targets: q.targets } : {}),
      })),
      pending: s.pendingTarget,
      pendingList: s.pendingTargets,
      showTargets: s.showTargets,
      // Sent marks paint only where focus is (default quiet); queued and
      // pending marks are unsent work and always paint. The full record still
      // rides above.
      shownCommitted: s.annotations.filter((a) => annotationFocused(s, a.id)).map((a) => a.id),
    });
  };

  const markOverlayReady = (): void => {
    readyEl = iframeEl;
    // The palette FIRST: an artifact that painted in the wrong theme and
    // corrected itself a frame later is a flash on every tab switch.
    toOverlay({
      source: "lucid-chrome",
      type: "theme",
      theme: currentTheme(),
    });
    // Pull the section-id set now the overlay is up: its own one-shot push at
    // connectedCallback can beat React installing the chrome's message
    // listener, so we ask again from this reliable point (fires on `ready` and
    // on the iframe onLoad fallback) rather than trusting the push alone.
    requestSections();
    outline.requestLayout(true);
  };

  /** Does this session hold work the swap must wait for? The membership is the
   *  store's (D-055 + the outbox, which is unsent work in exactly the same
   *  sense); this only asks. */
  const swapBlocked = (): boolean => blocksVersionSwap(unsentWork(get()));

  const noteLifecycle = (): void => {
    lifecycleSeq++;
  };

  const bootstrap = async (): Promise<void> => {
    const mine = ++bootstrapSeq;
    const lifecycleAtRequest = lifecycleSeq;
    const payload = await transport.get<StateResponse>(LUCID_ROUTES.state);
    // Guarded AFTER the body is parsed, not merely after the response arrives:
    // an older request can stall in the parse and land over a newer snapshot
    // that completed meanwhile. A malformed body applies nothing.
    if (!payload || mine !== bootstrapSeq) return;
    set((s) => {
      // Staged answer state is keyed by question id, and a question can be
      // settled from OUTSIDE this window (another tab, the CLI). Keep staging
      // only for questions still open, or the next shift-pick would attach
      // invisibly to an ask nobody can answer any more - and the pick-mode
      // arm would point at a ghost.
      const open = new Set((payload.questions ?? []).filter((q) => !q.answered).map((q) => q.id));
      const keep = <T>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([id]) => open.has(id)));
      for (const [id, imgs] of Object.entries(s.answerImages)) {
        if (!open.has(id)) for (const img of imgs) URL.revokeObjectURL(img.url);
      }
      return {
        // A deferred swap means the surface still SHOWS the older version, and
        // `version` is what new annotations are stamped with (D-066). The rest
        // of the fold - delivery state, the working window - is about the
        // conversation, not the frame, and must not wait on the draft.
        ...(pendingSwapHtml === null ? { version: payload.version } : {}),
        // The server's own lifecycle, not a status carried since the page
        // loaded: a session suspended - or healed - while this tab was away is
        // reported by the very request that heals it. The fallback is for a
        // session hosted by an OLDER dedicated server, which the hub proxies
        // and which reports no lifecycle at all.
        //
        // Dropped entirely when a lifecycle frame landed after this request
        // went out: the stream is then the newer source, and this snapshot
        // would roll the tab back to the status the server held before it.
        ...(lifecycleSeq === lifecycleAtRequest ? { status: payload.lifecycle ?? s.status } : {}),
        reviewResolved: payload.reviewResolved,
        verdicts: [...(payload.verdicts ?? [])],
        cleared: payload.cleared ?? null,
        annotations: [...payload.annotations],
        messages: [...payload.messages],
        questions: [...(payload.questions ?? [])],
        agentWorking: payload.agentWorking ?? null,
        lastTurnEnd: payload.lastTurnEnd ?? null,
        // The agent has spoken once a working window opens or a new version
        // lands - either closes the delivered-waiting gap. Cleared here rather
        // than on a timer, so an unattended send (nothing ever acks) keeps
        // saying "nothing is watching yet" truthfully instead of lapsing to
        // silence.
        // Clear the ids the payload now reports DELIVERED, not on "is anything
        // working". An unrelated turn's window said nothing about this send
        // (07#21), and a deduped send whose item is already delivered resolves
        // at once instead of waiting for an ack that will never come (07#22).
        awaitingAck: clearDelivered(s.awaitingAck, payload),
        agentsListening: payload.agentsListening ?? 0,
        lastAttendant: payload.lastAttendant ?? null,
        attendantPresence: payload.attendantPresence ?? null,
        resumable: payload.resumable === true,
        contextUsage: payload.contextUsage ?? null,
        answerAnchors: keep(s.answerAnchors),
        answerAnchorLists: keep(s.answerAnchorLists),
        answerImages: keep(s.answerImages),
        questionDrafts: keep(s.questionDrafts),
        answerPickFor:
          s.answerPickFor !== null && open.has(s.answerPickFor) ? s.answerPickFor : null,
      };
    });
    pushHighlights();
  };

  const applySwap = (html: string, version: number): void => {
    showHtml(html);
    // A live update supersedes a historical view: the surface is now the new
    // current, so history mode ends rather than showing a stale snapshot label.
    set((s) => ({ diffBase: s.version, version, newerVersion: null, viewingVersion: null }));
    pendingSwapHtml = null;
    void bootstrap();
  };

  const applyDeferredSwapIfReady = (): void => {
    const s = get();
    if (pendingSwapHtml !== null && s.newerVersion !== null && !swapBlocked()) {
      applySwap(pendingSwapHtml, s.newerVersion);
    }
  };

  const onNewVersion = async (version: number): Promise<void> => {
    const html = await transport.getText(LUCID_ROUTES.artifact);
    if (html === null) return;
    if (swapBlocked()) {
      pendingSwapHtml = html;
      set({ newerVersion: version });
      // The frame waits for the draft; the record does not. Without this the
      // panel keeps saying an agent is still working, and every delivery chip
      // stays at its pre-version answer, until the human sends.
      void bootstrap();
      return;
    }
    applySwap(html, version);
  };

  const attach = (el: HTMLIFrameElement | null): void => {
    if (el === iframeEl) return;
    if (el === null) {
      detachedIframeEl = iframeEl;
      iframeEl = null;
      outline.setLayoutAvailable(false);
      return;
    }
    if (detachedIframeEl !== null && el !== detachedIframeEl) {
      discardPendingOutlineChannel(detachedIframeEl.contentWindow);
      outline.resetChannel();
    } else if (iframeEl !== null && el !== iframeEl) {
      discardPendingOutlineChannel(iframeEl.contentWindow);
      outline.resetChannel();
    }
    iframeEl = el;
    detachedIframeEl = null;
    outline.setLayoutAvailable(effectiveOutlineLayoutAvailable());
    if (el.contentWindow) claimPendingOutlineChannel(el.contentWindow, acceptOutlinePort);
  };

  const attachOutlineSlot = (el: HTMLDivElement | null): void => {
    outlineSlotObserver?.disconnect();
    outlineSlotObserver = null;
    outlineSlotEl = el;
    outline.setLayoutAvailable(effectiveOutlineLayoutAvailable());
    if (el !== null) {
      outlineSlotObserver = new ResizeObserver(() => {
        // requestLayout revokes the previous proof synchronously. The iframe
        // runtime owns quieting and projection throttling; while a parent drag
        // or transition is active this is a deliberate no-op, followed by one
        // forced request when movement ends.
        outline.requestLayout();
      });
      outlineSlotObserver.observe(el);
    }
  };

  const setOutlineGeometryMoving = (source: "divider" | "drawer", moving: boolean): void => {
    const wasMoving = outlineGeometryMotions.size > 0;
    if (moving) outlineGeometryMotions.add(source);
    else outlineGeometryMotions.delete(source);
    if (wasMoving === outlineGeometryMotions.size > 0) return;
    outline.setLayoutAvailable(effectiveOutlineLayoutAvailable());
  };

  // SurfaceView: the nine named commands that replace raw toOverlay. Every
  // DOM-replacing path goes through showHtml, which arms the outline revision
  // barrier so the outline re-proofs against the new document.
  const showHtml = (
    html: string,
    options: { revision?: number; mode?: "diff-show" } = {},
  ): void => {
    toOverlay({
      html,
      revision: options.revision ?? outline.prepareRevision(),
      source: "lucid-chrome",
      type: options.mode === "diff-show" ? "diff-show" : "swap",
    });
  };
  const emphasize = (id: string, scroll: boolean): void =>
    toOverlay({
      id,
      source: "lucid-chrome",
      type: scroll ? "reveal-annotation" : "focus-annotation",
    });
  const revealSection = (lucidId: string, pulse: boolean): void =>
    toOverlay({
      lucidId,
      source: "lucid-chrome",
      type: pulse ? "pulse-section" : "reveal-section",
    });
  const gotoHunk = (hunkId: string): void =>
    toOverlay({ hunkId, source: "lucid-chrome", type: "diff-goto" });
  const requestSections = (): void =>
    toOverlay({ source: "lucid-chrome", type: "request-section-ids" });
  const measure = (): void => toOverlay({ source: "lucid-chrome", type: "measure-content" });
  const setTheme = (theme: "dark" | "light"): void =>
    toOverlay({ source: "lucid-chrome", theme, type: "theme" });
  const ping = (nonce: string): void => toOverlay({ nonce, source: "lucid-chrome", type: "ping" });

  const dispose = (): void => {
    outlineSlotObserver?.disconnect();
    outlineSlotObserver = null;
    unsubscribeOutlineChannels();
    discardPendingOutlineChannel(iframeEl?.contentWindow ?? null);
    discardPendingOutlineChannel(detachedIframeEl?.contentWindow ?? null);
    outline.dispose();
    iframeEl = null;
    detachedIframeEl = null;
    outlineSlotEl = null;
  };

  return {
    attach,
    attachOutlineSlot,
    requestOutlineLayout: outline.requestLayout,
    setOutlineActive: outline.setActive,
    setOutlineGeometryMoving,
    activateOutline: outline.activate,
    markOverlayReady,
    ownsSource,
    frameRect,
    outlineSlotRect,
    toOverlay,
    prepareRevision: outline.prepareRevision,
    showHtml,
    emphasize,
    revealSection,
    gotoHunk,
    requestSections,
    measure,
    setTheme,
    ping,
    pushHighlights,
    applyDeferredSwapIfReady,
    bootstrap,
    noteLifecycle,
    onNewVersion,
    dispose,
  };
};
