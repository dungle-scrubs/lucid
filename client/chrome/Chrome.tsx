import { useCallback, useEffect, useRef } from "react";
import { isOverlayMessage } from "../shared/protocol.ts";
import { SessionProvider } from "./context.tsx";
import { Header } from "./Header.tsx";
import { LucidRuntimeProvider } from "./runtime.tsx";
import type { SessionHandle } from "./session.ts";
import { Sessions } from "./Sessions.tsx";
import {
  CHROME_MIN_WIDTH,
  DEFAULT_CHROME_WIDTH,
  persistWidth,
  setChromeWidth,
  setSidebarOpen,
  setSidebarTab,
  useShell,
} from "./shell.ts";
import {
  DiffBar,
  Lightbox,
  NewerVersionBanner,
  SurfaceUpdating,
  VersionViewBanner,
} from "./Surface.tsx";
import { Thread } from "./Thread.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "./ui/sidebar.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Kbd } from "./ui/kbd.tsx";

const DIVIDER_WIDTH = 5;

/** True when a key event is destined for a text field, so window-level
 *  shortcuts can leave the caret alone. */
const isTextEntry = (node: EventTarget | null): boolean =>
  node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement;

/**
 * Everything window-level for the ACTIVE session: the overlay postMessage
 * bridge, the chrome's custom events, and the keyboard map. A hook rather
 * than inline in the view so the wiring reads as what it is - the active
 * session's connection to the window - and tears down whole when another
 * session takes the screen. The SSE stream is deliberately NOT here: it
 * belongs to the handle's roster lifetime (entry boot or tab open), so a
 * backgrounded session keeps folding events and draining its outbox.
 *
 * `panelDigits` guards ⌘1/⌘2: they switch the panel's own tabs in the
 * single-session viewer, but under the shell those digits belong to the
 * session tab bar and the Sessions panel does not exist.
 */
const useSessionWiring = (session: SessionHandle, panelDigits: boolean, active: boolean): void => {
  useEffect(() => {
    // A hidden tab's view stays mounted (drafts survive switching), but only
    // the ACTIVE session may own the window: N sets of keyboard/postMessage
    // listeners would all fire on one gesture.
    if (!active) return;
    const { store, surface, actions } = session;
    const get = store.getState;
    const set = store.setState;

    const onMessage = (e: MessageEvent): void => {
      if (!isOverlayMessage(e.data)) return;
      // Only this session's own iframe may speak for the surface: any frame
      // can forge an overlay-shaped payload, and under tabs a stale surface
      // must not mutate the active session's state.
      if (!surface.ownsSource(e.source)) return;
      const msg = e.data;
      if (msg.type === "ready") {
        surface.markOverlayReady();
        surface.pushHighlights();
      } else if (msg.type === "target-picked") {
        // A historical snapshot is read-only: its DOM is not the live artifact,
        // so an anchor captured against it would point at nothing on return.
        if (get().viewingVersion !== null) return;
        // Pinning a region for an open question's answer wins over starting a
        // new annotation: the pick attaches to that answer and exits pick mode.
        const pickFor = get().answerPickFor;
        if (pickFor !== null) {
          set((s) => ({
            answerAnchors: { ...s.answerAnchors, [pickFor]: msg.anchor },
            answerPickFor: null,
          }));
          return;
        }
        // A new pick is a new fork: drop any stable fork id held for the prior pick.
        set({ pendingTarget: msg.anchor, forkId: null });
        surface.pushHighlights();
      } else if (msg.type === "annotation-hover") {
        set({ hoveredId: msg.id });
      } else if (msg.type === "content-width") {
        // Size the surface to the content and give the rest to the review,
        // keeping the panel at or above its minimum. Fall back to the default
        // when there is nothing measurable.
        const width =
          msg.width <= 0
            ? DEFAULT_CHROME_WIDTH
            : Math.max(CHROME_MIN_WIDTH, window.innerWidth - DIVIDER_WIDTH - msg.width);
        setChromeWidth(width);
        persistWidth(width);
      } else if (msg.type === "annotation-activate") {
        set({ hoveredId: msg.id });
        document
          .querySelector(`[data-annotation-id="${msg.id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (msg.type === "section-ids") {
        set({ sectionIds: msg.ids });
      }
    };
    window.addEventListener("message", onMessage);

    // The chrome's own cards ask the overlay to light up their mark.
    const onFocusAnnotation = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      surface.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id });
    };
    window.addEventListener("lucid:focus-annotation", onFocusAnnotation);

    // Enter on a focused card: light the mark AND scroll the surface to it.
    const onRevealAnnotation = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      surface.toOverlay({ source: "lucid-chrome", type: "reveal-annotation", id });
    };
    window.addEventListener("lucid:reveal-annotation", onRevealAnnotation);

    // A thumb asks for the lightbox by URL; the action resolves it back to the
    // message's image list so the arrows can step through the set it came from.
    const onLightbox = (e: Event): void => {
      actions.openLightboxForSrc((e as CustomEvent<string>).detail);
    };
    window.addEventListener("lucid:lightbox", onLightbox);

    // Hunk navigation is a window listener, so it would otherwise steal arrows
    // from the caret and Escape from a composer while a text field has focus.
    const onDiffKey = (e: KeyboardEvent): void => {
      if (!get().diffMode) return;
      if (isTextEntry(e.target)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        actions.gotoHunk(get().diffIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        actions.gotoHunk(get().diffIndex - 1);
      } else if (e.key === "Escape") {
        void actions.exitDiff();
      }
    };
    window.addEventListener("keydown", onDiffKey);

    // cmd/ctrl+Enter is the queue's flush-from-anywhere. Unlike the composer's
    // plain Enter (which only queues the current note), this deliberately fires
    // inside text fields too - the whole point is to send without leaving the
    // keyboard, so it does not skip text-entry targets the way onDiffKey does.
    const onSendKey = (e: KeyboardEvent): void => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      if (e.shiftKey) return; // ⌘⇧↵ is Approve, handled below
      if (get().queue.length === 0 && !get().pendingTarget) return;
      e.preventDefault();
      void actions.sendAll();
    };
    window.addEventListener("keydown", onSendKey);

    // Panel-level shortcuts that fire from anywhere, text fields included:
    // ⌘1/⌘2 switch tabs, ⌘⇧↵ approves. Approve is shifted so a stray ⌘↵ (the
    // send-queue flush) can never end the review, and it defers to the button's
    // own guard rather than duplicating the unsent-work rule here.
    const onPanelKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (panelDigits && e.key === "1") {
        e.preventDefault();
        setSidebarTab("chat");
      } else if (panelDigits && e.key === "2") {
        e.preventDefault();
        setSidebarTab("sessions");
        void actions.loadSessions();
      } else if (!e.shiftKey && e.key === ".") {
        e.preventDefault();
        actions.toggleTargets();
      } else if (e.key === "Enter" && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void actions.approveReview();
      }
    };
    window.addEventListener("keydown", onPanelKey);

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("lucid:focus-annotation", onFocusAnnotation);
      window.removeEventListener("lucid:reveal-annotation", onRevealAnnotation);
      window.removeEventListener("lucid:lightbox", onLightbox);
      window.removeEventListener("keydown", onDiffKey);
      window.removeEventListener("keydown", onSendKey);
      window.removeEventListener("keydown", onPanelKey);
    };
  }, [session, panelDigits, active]);
};

/**
 * One session's whole screen: review panel, divider, header, artifact
 * surface. The single-session viewer IS this (Chrome below); the shell
 * renders it under a tab bar with `shell` set - which hides the panel's
 * Review/Sessions tab strip (the tab bar and ⌘K subsume the Sessions panel)
 * and cedes ⌘1-9 to the session tabs.
 */
export const SessionView = ({
  session,
  shell = false,
  active = true,
}: {
  readonly session: SessionHandle;
  readonly shell?: boolean;
  /** False for a hidden-but-mounted background tab: its DOM and component
   *  state persist, but it takes no window listeners and answers no keys. */
  readonly active?: boolean;
}) => {
  const chromeWidth = useShell((s) => s.chromeWidth);
  const sidebarOpen = useShell((s) => s.sidebarOpen);
  const sidebarTab = useShell((s) => s.sidebarTab);
  const dragging = useRef(false);

  useSessionWiring(session, !shell, active);

  // A callback ref, not an effect: attach must be synchronous with the
  // element entering the DOM, so a fast iframe `load` can never fire into a
  // null attachment (readiness would bind to nothing and the recovery path -
  // onLoad-as-ready - would be lost). Stable per session so React does not
  // detach/re-attach on every render.
  const attachSurface = useCallback(
    (el: HTMLIFrameElement | null) => session.surface.attach(el),
    [session],
  );

  // Divider drag. Pointer capture routes move/up to the divider even over the
  // iframe, which would otherwise swallow them.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    const startX = e.clientX;
    const startW = useShell.getState().chromeWidth;
    const onMove = (ev: PointerEvent): void => {
      if (!dragging.current) return;
      // Right-side panel: pointer moving LEFT grows the panel.
      const w = Math.max(
        CHROME_MIN_WIDTH,
        Math.min(window.innerWidth - 320, startW + (startX - ev.clientX)),
      );
      setChromeWidth(w);
    };
    const onUp = (): void => {
      dragging.current = false;
      persistWidth(useShell.getState().chromeWidth);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <SessionProvider session={session}>
      {/* The sidebar owns its width through --sidebar-width, so pointing that
          at the dragged width keeps the resize and the collapse as one
          mechanism instead of two fighting over the same edge. */}
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        hotkey={active}
        style={{ "--sidebar-width": `${chromeWidth}px` } as React.CSSProperties}
        className="h-full min-h-0"
      >
        <SidebarInset className="flex min-h-0 flex-col bg-ink-850">
          <Header />
          <div className="relative min-h-0 flex-1">
            <NewerVersionBanner />
            <DiffBar />
            <VersionViewBanner />
            <SurfaceUpdating />
            <iframe
              ref={attachSurface}
              title="artifact surface"
              src={`${session.config.base}/`}
              // No allow-same-origin: the artifact runs on an opaque origin so
              // its scripts cannot reach the control routes (D-020).
              sandbox="allow-scripts"
              // `ready` is a one-shot message and the listener is installed in
              // an effect, i.e. after this element exists. Load fires only once
              // the overlay's module has run, so treating it as ready too means
              // a missed `ready` cannot leave the surface permanently unpainted.
              onLoad={() => {
                session.surface.markOverlayReady();
                session.surface.pushHighlights();
              }}
              // bg-surface, not white: this is the paper the artifact renders
              // on, and it is the one place the chrome admits what is inside it
              // is a document rather than more app. It only shows before the
              // artifact paints (or through a transparent one), so it must not
              // be a different white than the paper the artifact assumes.
              className="h-full w-full border-0 bg-surface"
            />
          </div>
        </SidebarInset>
        {/* The window-splitter pattern: a separator carries the role, and arrow
            keys resize it for anything that cannot drag. Double-click asks the
            overlay to measure, because the parent cannot - the surface is on an
            opaque origin, so contentDocument is null from here. Hidden while
            collapsed: there is no panel edge to drag. */}
        {sidebarOpen ? (
          <hr
            aria-orientation="vertical"
            aria-label="Resize the review panel"
            aria-valuenow={chromeWidth}
            aria-valuemin={CHROME_MIN_WIDTH}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onDoubleClick={() =>
              session.surface.toOverlay({ source: "lucid-chrome", type: "measure-content" })
            }
            onKeyDown={(e) => {
              const step = e.shiftKey ? 64 : 16;
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              // The panel sits on the RIGHT: moving the divider left grows it.
              const next = Math.max(
                CHROME_MIN_WIDTH,
                Math.min(
                  window.innerWidth - 320,
                  chromeWidth + (e.key === "ArrowLeft" ? step : -step),
                ),
              );
              setChromeWidth(next);
              persistWidth(next);
            }}
            title="Drag to resize · double-click to fit the document"
            // The boundary is the 1px RIGHT BORDER (the panel's edge), same
            // border-box trick as before the flip: fixed footprint, line
            // thickens on hover without shifting the artifact.
            //
            // h-full is load-bearing: Tailwind's preflight sets hr{height:0}, so
            // without it the divider collapses to nothing - invisible and undraggable.
            style={{ width: DIVIDER_WIDTH }}
            className="m-0 h-full shrink-0 cursor-col-resize border-0 border-r-[1px] border-r-ink-600 bg-ink-850 hover:border-r-[2px] hover:border-r-accent-bright focus-visible:border-r-[2px] focus-visible:border-r-accent-bright"
          />
        ) : null}
        {/* The review panel, RIGHT (artifact-first D9): the surface is the
            primary concern in the center, the inference source at the edge.
            No border of its own: the divider draws the single boundary line. */}
        <Sidebar
          side="right"
          collapsible="offcanvas"
          className="group-data-[side=right]:border-l-0"
        >
          {shell ? (
            /* Under the shell the panel has one face: the review. The Sessions
               list is subsumed by the tab bar + the hub picker, so the tab
               strip would be a control with nothing to switch. */
            <div className="flex min-h-0 flex-1 flex-col pt-1">
              <LucidRuntimeProvider>
                <Thread />
              </LucidRuntimeProvider>
            </div>
          ) : (
            <Tabs
              value={sidebarTab}
              onValueChange={(v) => {
                setSidebarTab(v as "chat" | "sessions");
                // Fetch on first look rather than at boot: a review that never
                // opens the tab should never pay for a project-wide directory
                // scan. Refetch on every visit after that, because liveness is
                // exactly the thing that goes stale.
                if (v === "sessions") void session.actions.loadSessions();
              }}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              {/* No border and no fill of its own: the strip sits on the panel's
                own ground so it reads as a control in the panel, not a titlebar
                above it. The segmented track is the only thing drawn here. */}
              <SidebarHeader className="p-2 pb-1">
                <TabsList className="w-full">
                  <TabsTrigger value="chat" data-test="tab-chat">
                    Review
                    <Kbd className="ml-1">⌘1</Kbd>
                  </TabsTrigger>
                  <TabsTrigger value="sessions" data-test="tab-sessions">
                    Sessions
                    <Kbd className="ml-1">⌘2</Kbd>
                  </TabsTrigger>
                </TabsList>
              </SidebarHeader>
              {/* keepMounted is load-bearing: Base UI unmounts a hidden panel by
                default, which would throw away the composer draft, the unsent
                queue and the scroll position every time the human glanced at the
                sessions list. */}
              <TabsContent
                value="chat"
                keepMounted
                className="flex min-h-0 flex-1 flex-col data-[hidden]:hidden"
              >
                <LucidRuntimeProvider>
                  <Thread />
                </LucidRuntimeProvider>
              </TabsContent>
              <TabsContent value="sessions" className="flex min-h-0 flex-1 flex-col">
                <SidebarContent>
                  <Sessions />
                </SidebarContent>
              </TabsContent>
            </Tabs>
          )}
        </Sidebar>
        <Lightbox />
      </SidebarProvider>
    </SessionProvider>
  );
};

/** The single-session viewer page (a dedicated per-session server's
 *  `/__lucid/viewer`): one SessionView filling the window. */
export const Chrome = ({ session }: { readonly session: SessionHandle }) => (
  <div className="h-screen">
    <SessionView session={session} />
  </div>
);
