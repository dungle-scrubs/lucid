import { useEffect, useRef } from "react";
import type { LogEvent } from "../../src/core/events.ts";
import type { ChromeMessage, PayloadAnnotationLike } from "../shared/protocol.ts";
import { isOverlayMessage } from "../shared/protocol.ts";
import { Header } from "./Header.tsx";
import { LucidRuntimeProvider } from "./runtime.tsx";
import { api, get, persistWidth, set, useLucid, warn, CHROME_MIN_WIDTH } from "./store.ts";
import { Thread } from "./Thread.tsx";
import type { AgentQuestion, ConversationMessage, MessageImage } from "./types.ts";

const DIVIDER_WIDTH = 5;

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

const bootstrap = async (): Promise<void> => {
  const res = await api("/__lucid/state").catch(() => null);
  if (!res) return;
  const payload = (await res.json()) as {
    version: number;
    reviewResolved: boolean;
    annotations: PayloadAnnotationLike[];
    messages: ConversationMessage[];
    questions?: AgentQuestion[];
    warnings?: { code: string; message: string }[];
  };
  set({
    version: payload.version,
    reviewResolved: payload.reviewResolved,
    annotations: payload.annotations,
    messages: payload.messages,
    questions: payload.questions ?? [],
  });
  pushHighlights();
};

const onLogEvent = (ev: LogEvent): void => {
  switch (ev.t) {
    case "annotation":
    case "revert":
    case "question":
    case "question_answered":
      void bootstrap();
      break;
    case "prompt":
      set((s) => ({
        messages: [
          ...s.messages,
          {
            role: "human",
            text: ev.text,
            at: ev.at,
            ...(Array.isArray(ev.images) ? { images: ev.images as MessageImage[] } : {}),
          },
        ],
      }));
      break;
    case "agent_reply":
      set((s) => ({ messages: [...s.messages, { role: "agent", text: ev.text, at: ev.at }] }));
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
    source.onerror = () => warn("Lost the live connection - reload to resume.");

    void bootstrap();
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("lucid:focus-annotation", onFocusAnnotation);
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
      <div
        onPointerDown={onPointerDown}
        title="Drag to resize"
        className="cursor-col-resize bg-ink-700 hover:bg-accent-dim"
      />
      <div className="flex min-h-0 flex-col bg-ink-850">
        <Header />
        <iframe
          ref={iframeRef}
          title="artifact surface"
          src="/"
          // No allow-same-origin: the artifact runs on an opaque origin so its
          // scripts cannot reach the control routes (D-020).
          sandbox="allow-scripts"
          className="h-full w-full border-0 bg-white"
        />
      </div>
    </div>
  );
};
