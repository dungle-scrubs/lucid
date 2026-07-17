import type { StateResponse } from "../../src/protocol/wire.ts";
import type { ChromeMessage } from "../shared/protocol.ts";
import { api, get, set } from "./store.ts";

/**
 * The chrome's side of the surface: the one place that talks to the overlay
 * (postMessage into the sandboxed artifact iframe) and syncs folded state from
 * the server. Kept out of the components so actions and views both import the
 * transport instead of reaching into each other.
 */

let iframeEl: HTMLIFrameElement | null = null;
let overlayReady = false;
let pendingSwapHtml: string | null = null;

/** The Chrome shell registers its artifact iframe here on mount. */
export const setSurfaceIframe = (el: HTMLIFrameElement | null): void => {
  iframeEl = el;
};

/** The overlay signalled `ready` (or the iframe finished loading, which
 *  implies the overlay module ran - a missed one-shot `ready` must not leave
 *  the surface unpainted). */
export const markOverlayReady = (): void => {
  overlayReady = true;
};

export const toOverlay = (message: ChromeMessage): void => {
  iframeEl?.contentWindow?.postMessage(message, "*");
};

export const pushHighlights = (): void => {
  if (!overlayReady) return;
  const s = get();
  toOverlay({
    source: "lucid-chrome",
    type: "highlight",
    annotations: s.annotations,
    queued: s.queue.map((q) => ({ id: q.id, target: q.target })),
    pending: s.pendingTarget,
    showTargets: s.showTargets,
  });
};

const hasUnsentDraft = (): boolean => {
  const s = get();
  return s.queue.length > 0 || (s.pendingTarget !== null && s.composerNote.trim().length > 0);
};

const applySwap = (html: string, version: number): void => {
  toOverlay({ source: "lucid-chrome", type: "swap", html });
  set((s) => ({ diffBase: s.version, version, newerVersion: null }));
  pendingSwapHtml = null;
  void bootstrap();
};

export const applyDeferredSwapIfReady = (): void => {
  const s = get();
  if (pendingSwapHtml !== null && s.newerVersion !== null && !hasUnsentDraft()) {
    applySwap(pendingSwapHtml, s.newerVersion);
  }
};

/**
 * Bootstraps are fired from SSE frames, so several can be in flight at once.
 * Only the newest may land: an older snapshot arriving late would roll state
 * back over a message that has since been applied. A failure leaves state
 * alone rather than half-applying.
 */
let bootstrapSeq = 0;

export const bootstrap = async (): Promise<void> => {
  const mine = ++bootstrapSeq;
  const res = await api("/__lucid/state").catch(() => null);
  if (!res || mine !== bootstrapSeq) return;
  const payload = (await res.json()) as StateResponse;
  set({
    version: payload.version,
    reviewResolved: payload.reviewResolved,
    annotations: [...payload.annotations],
    messages: [...payload.messages],
    questions: [...(payload.questions ?? [])],
    agentWorking: payload.agentWorking ?? null,
    agentsListening: payload.agentsListening ?? 0,
    lastAttendant: payload.lastAttendant ?? null,
  });
  pushHighlights();
};

/** Live reload, deferred until the human's draft is committed (D-055). */
export const onNewVersion = async (version: number): Promise<void> => {
  const html = await api("/__lucid/artifact")
    .then((r) => r.text())
    .catch(() => null);
  if (html === null) return;
  if (hasUnsentDraft()) {
    pendingSwapHtml = html;
    set({ newerVersion: version });
    return;
  }
  applySwap(html, version);
};
