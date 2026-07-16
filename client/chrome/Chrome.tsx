import { useEffect, useRef } from "react";
import type { LogEvent } from "../../src/core/events.ts";
import type { ChromeMessage, PayloadAnnotationLike } from "../shared/protocol.ts";
import { isOverlayMessage } from "../shared/protocol.ts";
import { exitDiff, gotoHunk } from "./actions.ts";
import { Header } from "./Header.tsx";
import { LucidRuntimeProvider } from "./runtime.tsx";
import {
  api,
  get,
  persistWidth,
  set,
  useLucid,
  CHROME_MIN_WIDTH,
  DEFAULT_CHROME_WIDTH,
} from "./store.ts";
import { DiffBar, Lightbox, NewerVersionBanner, SurfaceUpdating } from "./Surface.tsx";
import { Thread } from "./Thread.tsx";
import type { AgentQuestion, ConversationMessage } from "./types.ts";

const DIVIDER_WIDTH = 5;

/** True when a key event is destined for a text field, so window-level
 *  shortcuts can leave the caret alone. */
const isTextEntry = (node: EventTarget | null): boolean =>
  node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement;

/** The chrome owns all server I/O; the overlay only does DOM targeting. */
let iframeEl: HTMLIFrameElement | null = null;
let overlayReady = false;
let pendingSwapHtml: string | null = null;

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

const bootstrap = async (): Promise<void> => {
  const mine = ++bootstrapSeq;
  const res = await api("/__lucid/state").catch(() => null);
  if (!res || mine !== bootstrapSeq) return;
  const payload = (await res.json()) as {
    version: number;
    reviewResolved: boolean;
    annotations: PayloadAnnotationLike[];
    messages: ConversationMessage[];
    questions?: AgentQuestion[];
    warnings?: { code: string; message: string }[];
    agentWorking?: { since: string; intent?: "revise" | "reply" };
  };
  set({
    version: payload.version,
    reviewResolved: payload.reviewResolved,
    annotations: payload.annotations,
    messages: payload.messages,
    questions: payload.questions ?? [],
    agentWorking: payload.agentWorking ?? null,
  });
  pushHighlights();
};

const onLogEvent = (ev: LogEvent): void => {
  switch (ev.t) {
    // Every content event re-reads the folded state rather than patching it
    // locally. The log is the source of truth and the fold does real work
    // (anchor carry-forward, orphaning, image paths); a local append would be a
    // second, worse copy of it - and could be silently dropped by a bootstrap
    // that started before the append landed.
    case "annotation":
    case "revert":
    case "question":
    case "question_answered":
    case "prompt":
    case "agent_reply":
    case "agent_ack":
      void bootstrap();
      break;
    case "version":
      void onNewVersion(ev.version);
      break;
    case "review_resolved":
      set({ reviewResolved: true });
      break;
    case "review_reopened":
      set({ reviewResolved: false });
      break;
    case "session_ended":
      set({ status: "ended" });
      break;
    case "session_suspended":
      set({ status: "suspended" });
      break;
    default:
      break;
  }
};

/** Live reload, deferred until the human's draft is committed (D-055). */
const onNewVersion = async (version: number): Promise<void> => {
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

export const Chrome = () => {
  const chromeWidth = useLucid((s) => s.chromeWidth);
  const dragging = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    iframeEl = iframeRef.current;

    const onMessage = (e: MessageEvent): void => {
      if (!isOverlayMessage(e.data)) return;
      const msg = e.data;
      if (msg.type === "ready") {
        overlayReady = true;
        pushHighlights();
      } else if (msg.type === "target-picked") {
        set({ pendingTarget: msg.anchor });
        pushHighlights();
      } else if (msg.type === "annotation-hover") {
        set({ hoveredId: msg.id });
      } else if (msg.type === "content-width") {
        // Size the surface to the content and give the rest to the review,
        // keeping the panel at or above its minimum. Fall back to the default
        // when there is nothing measurable.
        set({
          chromeWidth:
            msg.width <= 0
              ? DEFAULT_CHROME_WIDTH
              : Math.max(CHROME_MIN_WIDTH, window.innerWidth - DIVIDER_WIDTH - msg.width),
        });
        persistWidth(get().chromeWidth);
      } else if (msg.type === "annotation-activate") {
        set({ hoveredId: msg.id });
        document
          .querySelector(`[data-annotation-id="${msg.id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    window.addEventListener("message", onMessage);

    // The chrome's own cards ask the overlay to light up their mark.
    const onFocusAnnotation = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      toOverlay({ source: "lucid-chrome", type: "focus-annotation", id });
    };
    window.addEventListener("lucid:focus-annotation", onFocusAnnotation);

    // A thumb asks for the lightbox by URL; resolve it back to the message's
    // image list so the arrows can step through the set it came from.
    const onLightbox = (e: Event): void => {
      const src = (e as CustomEvent<string>).detail;
      const file = src.split("/").pop() ?? "";
      const owner = get().messages.find((m) => m.images?.some((i) => i.file === file));
      const images = owner?.images;
      if (!images) return;
      set({ lightboxImages: images, lightboxIndex: images.findIndex((i) => i.file === file) });
    };
    window.addEventListener("lucid:lightbox", onLightbox);

    // Hunk navigation is a window listener, so it would otherwise steal arrows
    // from the caret and Escape from a composer while a text field has focus.
    const onDiffKey = (e: KeyboardEvent): void => {
      if (!get().diffMode) return;
      if (isTextEntry(e.target)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        gotoHunk(get().diffIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        gotoHunk(get().diffIndex - 1);
      } else if (e.key === "Escape") {
        void exitDiff();
      }
    };
    window.addEventListener("keydown", onDiffKey);

    const source = new EventSource("/__lucid/events");
    source.onmessage = (e) => {
      try {
        onLogEvent(JSON.parse(e.data) as LogEvent);
      } catch {
        /* a frame we cannot parse is not worth tearing the stream down for */
      }
    };
    source.addEventListener("warning", (e) => {
      try {
        const w = JSON.parse((e as MessageEvent).data) as { code: string; message: string };
        set((s) => ({ warnings: [...s.warnings, w] }));
      } catch {
        /* ignore */
      }
    });
    // EventSource retries on its own, so a drop is a state to show, not a
    // warning to accumulate: warning per failed attempt spammed the panel and
    // told the human to reload, which was never true.
    source.onopen = () => set({ live: true });
    source.onerror = () => set({ live: false });

    void bootstrap();
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("lucid:focus-annotation", onFocusAnnotation);
      window.removeEventListener("lucid:lightbox", onLightbox);
      window.removeEventListener("keydown", onDiffKey);
      source.close();
    };
  }, []);

  // Divider drag. Pointer capture routes move/up to the divider even over the
  // iframe, which would otherwise swallow them.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    const startX = e.clientX;
    const startW = get().chromeWidth;
    const onMove = (ev: PointerEvent): void => {
      if (!dragging.current) return;
      const w = Math.max(
        CHROME_MIN_WIDTH,
        Math.min(window.innerWidth - 320, startW + (ev.clientX - startX)),
      );
      set({ chromeWidth: w });
    };
    const onUp = (): void => {
      dragging.current = false;
      persistWidth(get().chromeWidth);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="grid h-screen"
      style={{ gridTemplateColumns: `${chromeWidth}px ${DIVIDER_WIDTH}px 1fr` }}
    >
      <div className="flex min-h-0 flex-col border-r border-ink-600 bg-bg">
        <LucidRuntimeProvider>
          <Thread />
        </LucidRuntimeProvider>
      </div>
      {/* The window-splitter pattern: a separator carries the role, and arrow
          keys resize it for anything that cannot drag. Double-click asks the
          overlay to measure, because the parent cannot - the surface is on an
          opaque origin, so contentDocument is null from here. */}
      <hr
        aria-orientation="vertical"
        aria-label="Resize the review panel"
        aria-valuenow={chromeWidth}
        aria-valuemin={CHROME_MIN_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => toOverlay({ source: "lucid-chrome", type: "measure-content" })}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16;
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const next = Math.max(
            CHROME_MIN_WIDTH,
            Math.min(
              window.innerWidth - 320,
              chromeWidth + (e.key === "ArrowRight" ? step : -step),
            ),
          );
          set({ chromeWidth: next });
          persistWidth(next);
        }}
        title="Drag to resize · double-click to fit the document"
        // h-full is load-bearing: Tailwind's preflight sets hr{height:0}, so with
        // border-0 the divider collapses to nothing - invisible and undraggable.
        className="m-0 h-full w-full cursor-col-resize border-0 bg-ink-700 hover:bg-accent-dim focus-visible:bg-accent"
      />
      <div className="flex min-h-0 flex-col bg-ink-850">
        <Header />
        <div className="relative min-h-0 flex-1">
          <NewerVersionBanner />
          <DiffBar />
          <SurfaceUpdating />
          <iframe
            ref={iframeRef}
            title="artifact surface"
            src="/"
            // No allow-same-origin: the artifact runs on an opaque origin so its
            // scripts cannot reach the control routes (D-020).
            sandbox="allow-scripts"
            // `ready` is a one-shot message and the listener is installed in an
            // effect, i.e. after this element exists. Load fires only once the
            // overlay's module has run, so treating it as ready too means a
            // missed `ready` cannot leave the surface permanently unpainted.
            onLoad={() => {
              overlayReady = true;
              pushHighlights();
            }}
            className="h-full w-full border-0 bg-white"
          />
        </div>
      </div>
      <Lightbox />
    </div>
  );
};
