import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Anchor } from "../../src/anchors/anchor.ts";
import { isOverlayMessage } from "../shared/protocol.ts";
import { SessionProvider, useSession } from "./context.tsx";
import {
  MAX_PICK_TARGETS,
  selectOutlineGeneration,
  selectOutlineHealthCode,
  toggleAnchor,
} from "./store.ts";
import { Header } from "./Header.tsx";
import { QuestionDrawer, useQuestionDrawer } from "./QuestionDrawer.tsx";
import { LucidRuntimeProvider } from "./runtime.tsx";
import type { SessionHandle } from "./session.ts";
import { Sessions } from "./Sessions.tsx";
import { SurfaceControls } from "./surface-controls.tsx";
import {
  CHROME_MIN_WIDTH,
  defaultChromeWidth,
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
  SessionGoneBanner,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const DIVIDER_WIDTH = 5;

/** True when a key event is destined for a text field, so window-level
 *  shortcuts can leave the caret alone. contentEditable counts: the composer's
 *  rich-text mode is not a <textarea>, and a shortcut that skips only the two
 *  tag names still fires mid-sentence there. */
const isTextEntry = (node: EventTarget | null): boolean =>
  node instanceof HTMLTextAreaElement ||
  node instanceof HTMLInputElement ||
  (node instanceof HTMLElement && node.isContentEditable);

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
    session.surface.setOutlineActive(active);
    // A hidden tab's view stays mounted (drafts survive switching), but only
    // the ACTIVE session may own the window: N sets of keyboard/postMessage
    // listeners would all fire on one gesture.
    if (!active) return;
    const { store, surface, actions, notify } = session;
    const get = store.getState;
    const set = store.setState;

    // The cmd-collect cap mirrors the server's (it rejects longer lists), so
    // the ninth pick is refused HERE, where the human can still see why,
    // rather than at send time. toggleAnchor returns the list untouched (same
    // reference) only in that case.
    const droppedAtCap = (cur: readonly Anchor[], next: readonly Anchor[]): boolean =>
      next === cur && cur.length >= MAX_PICK_TARGETS;
    const capNotice = (): void =>
      notify.notice(`Up to ${MAX_PICK_TARGETS} spots per note - that pick was not added.`);

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
        const meta = msg.modifiers?.meta ?? false;
        const shift = msg.modifiers?.shift ?? false;
        // Pinning a region onto an answer wins over starting a new annotation:
        // an armed pick mode ("Pin a spot"), or shift held while a question is
        // outstanding - the same pin without arming first. Shift+cmd collects
        // several pins (a repeat pick removes its spot); otherwise the pick
        // replaces. Shift with NO outstanding question falls through to the
        // composer below - never a dead gesture.
        const s0 = get();
        const pinFor =
          s0.answerPickFor ?? (shift ? (s0.questions.find((q) => !q.answered)?.id ?? null) : null);
        if (pinFor !== null) {
          const cur = s0.answerAnchorLists[pinFor] ?? [];
          const next = meta && shift ? toggleAnchor(cur, msg.anchor) : [msg.anchor];
          if (droppedAtCap(cur, next)) {
            capNotice();
            return;
          }
          set((s) => {
            const anchors = { ...s.answerAnchors };
            const lists = { ...s.answerAnchorLists };
            const first = next[0];
            if (first === undefined) {
              delete anchors[pinFor];
              delete lists[pinFor];
            } else {
              anchors[pinFor] = first;
              lists[pinFor] = next;
            }
            return {
              answerAnchors: anchors,
              answerAnchorLists: lists,
              answerPickFor: null,
              // A shift-pin lands on the drawer's question even while the
              // drawer is lowered, so raise it: the gesture must produce a
              // visible chip, not a silent attachment.
              questionDrawerDismissed: [],
            };
          });
          return;
        }
        // Cmd collects: several picks accumulate into ONE draft whose note
        // covers them all (a repeat pick removes its spot - the multi-select
        // toggle). A plain pick replaces, as ever. Either way this is a new
        // fork candidate: drop any stable fork id held for the prior pick.
        const cur = s0.pendingTargets;
        const next = meta ? toggleAnchor(cur, msg.anchor) : [msg.anchor];
        if (droppedAtCap(cur, next)) {
          capNotice();
          return;
        }
        // Toggling the LAST spot off ends the draft, same as the chip path:
        // a bare set would unmount the composer but keep its note and images,
        // resurrecting them (and their un-revoked object URLs) on the next pick.
        if (next.length === 0) {
          actions.discardPending();
          return;
        }
        set({
          pendingTargets: next,
          pendingTarget: next[0] ?? null,
          // The decision this pick belongs to, or none. On a cmd-collect the
          // LATEST pick decides: that is the one the human just pointed at,
          // and offering Agree for a decision they collected three picks ago
          // would answer something they have moved on from.
          pendingDecision: msg.decision ?? null,
          forkId: null,
        });
        surface.pushHighlights();
      } else if (msg.type === "annotation-hover") {
        set({ hoveredId: msg.id });
      } else if (msg.type === "content-width") {
        // Size the surface to the content and give the rest to the review,
        // keeping the panel at or above its minimum. Fall back to the default
        // when there is nothing measurable.
        const width =
          msg.width <= 0
            ? defaultChromeWidth(window.innerWidth)
            : Math.max(CHROME_MIN_WIDTH, window.innerWidth - DIVIDER_WIDTH - msg.width);
        setChromeWidth(width);
        persistWidth(width);
      } else if (msg.type === "annotation-activate") {
        set({ hoveredId: msg.id });
        document
          .querySelector(`[data-annotation-id="${msg.id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (msg.type === "section-ids") {
        set({
          sectionIds: msg.ids,
          ...(msg.added !== undefined
            ? {
                addedSectionVisibility: Object.fromEntries(
                  msg.added.map((section) => [section.id, section.inViewport]),
                ),
                emphasizedSectionIds: new Set<string>(),
              }
            : {}),
        });
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
        // NOT while typing. The composer teaches ⇧↵ for a newline in its own
        // placeholder, so ⌘⇧↵ is one slipped modifier away from ending the
        // review - silently, mid-sentence, with the draft still in the box.
        // That happened; the log records an approval nobody meant to make.
        // Approving from a text field buys nothing (the button and ⌘K are both
        // one gesture away) and costs a review that cannot be un-ended without
        // the agent already having been released.
        if (isTextEntry(e.target)) return;
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
      surface.setOutlineActive(false);
    };
  }, [session, panelDigits, active]);
};

/**
 * The artifact region: the surface itself plus everything that overlays it -
 * the version banners and the question drawer. Its own component because it
 * must read the session store (the drawer's raised state drives the parallax),
 * and SessionView is the thing that PROVIDES that store.
 */
const SurfaceRegion = ({
  active,
  session,
  attachSurface,
}: {
  readonly active: boolean;
  readonly session: SessionHandle;
  readonly attachSurface: (el: HTMLIFrameElement | null) => void;
}) => {
  const drawer = useQuestionDrawer();
  const outlineCode = useSession(selectOutlineHealthCode);
  const outlineGeneration = useSession(selectOutlineGeneration);
  const bottomOverlayObserver = useRef<ResizeObserver | null>(null);
  const previousDrawerRaised = useRef(drawer.raised);
  const [bottomOverlayHeight, setBottomOverlayHeight] = useState(0);
  const attachBottomOverlay = useCallback((element: HTMLElement | null): void => {
    bottomOverlayObserver.current?.disconnect();
    bottomOverlayObserver.current = null;
    if (element === null) {
      setBottomOverlayHeight((height) => (height === 0 ? height : 0));
      return;
    }
    const measure = (): void => {
      const height = element.getBoundingClientRect().height;
      setBottomOverlayHeight((current) => (current === height ? current : height));
    };
    measure();
    bottomOverlayObserver.current = new ResizeObserver(measure);
    bottomOverlayObserver.current.observe(element);
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      previousDrawerRaised.current = drawer.raised;
      session.surface.setOutlineGeometryMoving("drawer", false);
      return;
    }
    if (previousDrawerRaised.current === drawer.raised) return;
    previousDrawerRaised.current = drawer.raised;
    session.surface.setOutlineGeometryMoving("drawer", true);
  }, [active, drawer.raised, session]);
  useEffect(() => () => bottomOverlayObserver.current?.disconnect(), []);
  useEffect(() => () => session.surface.setOutlineGeometryMoving("drawer", false), [session]);
  return (
    <section
      data-test="surface-region"
      data-outline-health={outlineCode}
      data-outline-generation={outlineGeneration}
      aria-label="Artifact review surface"
      tabIndex={-1}
      className="relative min-h-0 flex-1 overflow-hidden outline-none focus-visible:annot-outline"
    >
      <NewerVersionBanner />
      <DiffBar />
      <VersionViewBanner />
      <SessionGoneBanner />
      <SurfaceControls bottomOverlayHeight={bottomOverlayHeight} />
      {/* The surface parallaxes UP while the question drawer is raised - the
          projects drawer's motion language, rotated. The artifact stays live
          and targetable the whole time; the drawer covers only its own band. */}
      <div
        data-test="artifact-parallax"
        onTransitionRun={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.propertyName === "transform" || event.propertyName === "translate")
          ) {
            session.surface.setOutlineGeometryMoving("drawer", true);
          }
        }}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.propertyName === "transform" || event.propertyName === "translate")
          ) {
            session.surface.setOutlineGeometryMoving("drawer", false);
          }
        }}
        onTransitionCancel={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.propertyName === "transform" || event.propertyName === "translate")
          ) {
            session.surface.setOutlineGeometryMoving("drawer", false);
          }
        }}
        className={`h-full w-full transition-transform duration-200 ease-out ${
          drawer.raised ? "-translate-y-3" : "translate-y-0"
        }`}
      >
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
      {/* Over the SURFACE, never the review panel: a pending question is about
          the artifact, and the artifact must stay visible while it is
          answered (D11). */}
      <QuestionDrawer state={drawer} attach={attachBottomOverlay} />
    </section>
  );
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
  const dragging = useRef<number | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  // Render state (not a ref): the slide duration is a style the panel reads.
  const [resizing, setResizing] = useState(false);

  useSessionWiring(session, !shell, active);
  useEffect(
    () => () => {
      stopDrag.current?.();
    },
    [],
  );

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
    if (dragging.current !== null) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = e.pointerId;
    setResizing(true);
    session.surface.setOutlineGeometryMoving("divider", true);
    const startX = e.clientX;
    const startW = useShell.getState().chromeWidth;
    const onMove = (ev: PointerEvent): void => {
      if (dragging.current !== ev.pointerId) return;
      // Right-side panel: pointer moving LEFT grows the panel.
      const w = Math.max(
        CHROME_MIN_WIDTH,
        Math.min(window.innerWidth - 320, startW + (startX - ev.clientX)),
      );
      setChromeWidth(w);
    };
    const removeListeners = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    const onUp = (event: PointerEvent): void => {
      if (dragging.current !== event.pointerId) return;
      stopDrag.current?.();
      setResizing(false);
      persistWidth(useShell.getState().chromeWidth);
    };
    stopDrag.current = () => {
      removeListeners();
      dragging.current = null;
      stopDrag.current = null;
      session.surface.setOutlineGeometryMoving("divider", false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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
        style={
          {
            "--sidebar-width": `${chromeWidth}px`,
            // Full-bleed under the shell: the drawer runs top to bottom beside
            // the tab strip, rather than starting below it. The strip keeps
            // clear of it by ending where the drawer begins (Shell.tsx).
            ...(shell ? { "--lucid-shell-top": "0px" } : {}),
            // A drag sets the width every pointermove; animating it would trail
            // the hand. Open/close keeps the 200ms slide.
            ...(resizing ? { "--sidebar-tx": "0ms" } : {}),
          } as React.CSSProperties
        }
        className="h-full min-h-0"
      >
        <SidebarInset className="flex min-h-0 flex-col bg-ink-850">
          <Header shell={shell} />
          <SurfaceRegion active={active} session={session} attachSurface={attachSurface} />
        </SidebarInset>
        {/* The window-splitter pattern: a separator carries the role, and arrow
            keys resize it for anything that cannot drag. Double-click asks the
            overlay to measure, because the parent cannot - the surface is on an
            opaque origin, so contentDocument is null from here. Hidden while
            collapsed: there is no panel edge to drag. */}
        {sidebarOpen ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <hr
                  aria-orientation="vertical"
                  aria-label="Resize the review panel"
                  aria-valuenow={chromeWidth}
                  aria-valuemin={CHROME_MIN_WIDTH}
                  tabIndex={0}
                  onPointerDown={onPointerDown}
                  onDoubleClick={() =>
                    session.surface.toOverlay({
                      source: "lucid-chrome",
                      type: "measure-content",
                    })
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
                  // The boundary is the 1px LEFT border, so the artifact meets the
                  // line with nothing between them. It used to be the right
                  // border over a filled 5px band, which put four pixels of
                  // chrome between the document and its own edge - a gap that
                  // read as a mistake at every window size.
                  //
                  // The footprint stays 5px because that is the drag target; it
                  // now sits on the PANEL's side of the line and carries no
                  // background of its own, so it disappears into the panel.
                  // Border-box means a hover thickening the line grows into that
                  // band rather than shifting the artifact.
                  //
                  // h-full is load-bearing: Tailwind's preflight sets hr{height:0}, so
                  // without it the divider collapses to nothing - invisible and undraggable.
                  style={{ width: DIVIDER_WIDTH }}
                  className="m-0 h-full shrink-0 cursor-col-resize border-0 border-l-[1px] border-l-ink-600 bg-transparent hover:border-l-[2px] hover:border-l-accent-bright focus-visible:border-l-[2px] focus-visible:border-l-accent-bright"
                />
              }
            />
            <TooltipContent>Drag to resize · double-click to fit the document</TooltipContent>
          </Tooltip>
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
