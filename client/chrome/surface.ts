import type { StateResponse } from "../../src/protocol/wire.ts";
import type { ChromeMessage } from "../shared/protocol.ts";
import type { SessionStore } from "./store.ts";
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
  /** The overlay signalled `ready` (or the iframe finished loading, which
   *  implies the overlay module ran - a missed one-shot `ready` must not leave
   *  the surface unpainted). */
  readonly markOverlayReady: () => void;
  /** True when a postMessage source is this session's own iframe. The window
   *  `message` handler must check this: any frame can forge an overlay-shaped
   *  payload, and under tabs a stale surface must not mutate another
   *  session's state. */
  readonly ownsSource: (source: MessageEventSource | null) => boolean;
  readonly toOverlay: (message: ChromeMessage) => void;
  readonly pushHighlights: () => void;
  readonly applyDeferredSwapIfReady: () => void;
  readonly bootstrap: () => Promise<void>;
  /** Live reload, deferred until the human's draft is committed (D-055). */
  readonly onNewVersion: (version: number) => Promise<void>;
  readonly hasUnsentDraft: () => boolean;
}

export const createSurface = (store: SessionStore, transport: Transport): Surface => {
  const get = store.getState;
  const set = store.setState;

  let iframeEl: HTMLIFrameElement | null = null;
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

  const toOverlay = (message: ChromeMessage): void => {
    iframeEl?.contentWindow?.postMessage(message, "*");
  };

  const overlayReady = (): boolean => iframeEl !== null && iframeEl === readyEl;

  const pushHighlights = (): void => {
    if (!overlayReady()) return;
    const s = get();
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
        ...(q.targets.length > 1 ? { targets: q.targets } : {}),
      })),
      pending: s.pendingTarget,
      pendingList: s.pendingTargets,
      showTargets: s.showTargets,
    });
  };

  const markOverlayReady = (): void => {
    readyEl = iframeEl;
    // Pull the section-id set now the overlay is up: its own one-shot push at
    // connectedCallback can beat React installing the chrome's message
    // listener, so we ask again from this reliable point (fires on `ready` and
    // on the iframe onLoad fallback) rather than trusting the push alone.
    toOverlay({ source: "lucid-chrome", type: "request-section-ids" });
  };

  const hasUnsentDraft = (): boolean => {
    const s = get();
    return s.queue.length > 0 || (s.pendingTarget !== null && s.composerNote.trim().length > 0);
  };

  const bootstrap = async (): Promise<void> => {
    const mine = ++bootstrapSeq;
    const res = await transport.api("/__lucid/state").catch(() => null);
    if (!res || mine !== bootstrapSeq) return;
    const payload = (await res.json().catch(() => null)) as StateResponse | null;
    // Re-check AFTER the body read too: an older request can pass the first
    // guard, stall while parsing, and land over a newer snapshot that
    // completed meanwhile. A malformed body applies nothing.
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
        reviewResolved: payload.reviewResolved,
        annotations: [...payload.annotations],
        messages: [...payload.messages],
        questions: [...(payload.questions ?? [])],
        agentWorking: payload.agentWorking ?? null,
        agentsListening: payload.agentsListening ?? 0,
        lastAttendant: payload.lastAttendant ?? null,
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
    toOverlay({ source: "lucid-chrome", type: "swap", html });
    // A live update supersedes a historical view: the surface is now the new
    // current, so history mode ends rather than showing a stale snapshot label.
    set((s) => ({ diffBase: s.version, version, newerVersion: null, viewingVersion: null }));
    pendingSwapHtml = null;
    void bootstrap();
  };

  const applyDeferredSwapIfReady = (): void => {
    const s = get();
    if (pendingSwapHtml !== null && s.newerVersion !== null && !hasUnsentDraft()) {
      applySwap(pendingSwapHtml, s.newerVersion);
    }
  };

  const onNewVersion = async (version: number): Promise<void> => {
    const html = await transport
      .api("/__lucid/artifact")
      .then((r) => r.text())
      .catch(() => null);
    if (html === null) return;
    if (hasUnsentDraft()) {
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
    iframeEl = el;
  };

  const ownsSource = (source: MessageEventSource | null): boolean =>
    iframeEl !== null && source === iframeEl.contentWindow;

  return {
    attach,
    markOverlayReady,
    ownsSource,
    toOverlay,
    pushHighlights,
    applyDeferredSwapIfReady,
    bootstrap,
    onNewVersion,
    hasUnsentDraft,
  };
};
