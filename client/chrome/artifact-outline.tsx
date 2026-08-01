import {
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ARTIFACT_OUTLINE_POLICY,
  reduceOutlinePresentation,
  type OutlinePresentationEvent,
  type OutlinePresentationMode,
  type OutlinePresentationState,
  type OutlineSnapshot,
} from "../shared/artifact-outline.ts";
import { useSession, useSessionHandle } from "./context.tsx";
import { selectOutlinePending, selectOutlineSnapshot } from "./store.ts";
import { Button } from "./ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";

const HOVER_INTENT_MS = 120;
const HOVER_LEAVE_MS = 180;
const PENDING_FOCUS_HOLD_MS = 500;

const ListIcon = () => (
  // lucide list
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
    <path d="M3 6h.01" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M8 6h13" />
  </svg>
);

const initialMode = (snapshot: OutlineSnapshot | null): OutlinePresentationState => {
  if (snapshot === null) return { mode: "ABSENT" };
  return reduceOutlinePresentation(
    { mode: "ABSENT" },
    {
      headingCount: snapshot.headings.length,
      proof: snapshot.proof,
      type: "projection",
    },
  ).state;
};

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface OutlinePanelProps {
  readonly mode: OutlinePresentationMode;
  readonly onActivate: (key: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly snapshot: OutlineSnapshot;
}

const OutlinePanel = ({ mode, onActivate, snapshot }: OutlinePanelProps) => (
  <div
    data-test="artifact-outline-panel"
    data-mode={mode.toLowerCase()}
    className={`pointer-events-auto flex max-h-full min-h-0 w-full flex-col border border-ink-500 bg-ink-850/95 text-fg ${
      mode === "PINNED" ? "" : "shadow-[0_8px_24px_rgba(0,0,0,0.42)]"
    }`}
  >
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-ink-600 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
      <span className="size-3.5" aria-hidden="true">
        <ListIcon />
      </span>
      Sections
    </div>
    <nav aria-label="Artifact sections" className="min-h-0 overflow-y-auto py-1">
      {snapshot.headings.map((heading) => {
        const current = heading.key === snapshot.activeKey;
        return (
          <Button
            key={heading.key}
            type="button"
            variant="ghost"
            size="xs"
            aria-current={current ? "location" : undefined}
            aria-label={heading.label}
            title={heading.label}
            data-test="artifact-outline-item"
            data-outline-key={heading.key}
            onClick={(event) => onActivate(heading.key, event)}
            className="flex h-7 w-full cursor-pointer justify-start rounded-none px-2 text-left text-[11px] font-normal text-fg-muted hover:bg-ink-700 hover:text-fg-strong focus-visible:annot-outline aria-[current=location]:bg-ink-700 aria-[current=location]:text-accent-bright"
          >
            <span className="truncate">{heading.label}</span>
          </Button>
        );
      })}
    </nav>
  </div>
);

export const ArtifactOutline = () => {
  const sourceSnapshot = useSession(selectOutlineSnapshot);
  const projectionPending = useSession(selectOutlinePending);
  const { surface } = useSessionHandle();
  const [renderedSnapshot, setRenderedSnapshot] = useState(sourceSnapshot);
  const [presentation, setPresentation] = useState(() => initialMode(sourceSnapshot));
  const presentationRef = useRef(presentation);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerFocusingRail = useRef(false);
  const suppressRailFocusOpen = useRef(false);
  const touchOpeningRail = useRef(false);
  const touchOpeningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const snapshot =
    sourceSnapshot?.generation === renderedSnapshot?.generation ? sourceSnapshot : renderedSnapshot;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const focusSurface = useCallback((): void => {
    rootRef.current?.closest<HTMLElement>('[data-test="surface-region"]')?.focus();
  }, []);

  const transition = useCallback(
    (
      event: OutlinePresentationEvent,
      basis: OutlinePresentationState = presentationRef.current,
    ): OutlinePresentationMode => {
      const previous = presentationRef.current;
      const result = reduceOutlinePresentation(basis, event);
      if (result.effects?.includes("focus-surface")) focusSurface();
      const next = result.state;
      const previousOrigin =
        previous.mode === "TRANSIENT_LATCHED" ? previous.latchOrigin : undefined;
      const nextOrigin = next.mode === "TRANSIENT_LATCHED" ? next.latchOrigin : undefined;
      presentationRef.current = next;
      if (previous.mode !== next.mode || previousOrigin !== nextOrigin) {
        setPresentation(next);
      }
      return next.mode;
    },
    [focusSurface],
  );

  useLayoutEffect(() => {
    const focusedElement = document.activeElement;
    const focusInside = rootRef.current?.contains(focusedElement) === true;
    if (sourceSnapshot === null) {
      if (projectionPending) {
        // Geometry is no longer proved. A focused pinned control becomes a
        // transient latch immediately so focus and section identity survive
        // the short reproof, but stale geometry never remains painted as
        // pinned. Without focus, fail closed and remove the projection now.
        if (focusInside && renderedSnapshot !== null && snapshotRef.current !== null) {
          transition({
            focusInside: true,
            headingCount: renderedSnapshot.headings.length,
            proof: { clearancePx: 0, complete: false },
            type: "projection",
          });
          if (pendingTimer.current === null) {
            pendingTimer.current = setTimeout(() => {
              pendingTimer.current = null;
              const stillFocused = rootRef.current?.contains(document.activeElement) === true;
              transition({
                focusInside: stillFocused,
                preserveHysteresis: true,
                type: "invalidate",
              });
              setRenderedSnapshot(null);
            }, PENDING_FOCUS_HOLD_MS);
          }
        } else {
          transition({
            focusInside: false,
            preserveHysteresis: true,
            type: "invalidate",
          });
          setRenderedSnapshot(null);
        }
        return;
      }
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      transition({ focusInside, type: "invalidate" });
      setRenderedSnapshot(null);
      return;
    }
    if (sourceSnapshot.generation === renderedSnapshot?.generation) return;
    if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    const focusedOutlineKey =
      focusedElement instanceof HTMLElement ? focusedElement.dataset.outlineKey : undefined;
    const stableFocusedItem =
      focusedOutlineKey !== undefined &&
      sourceSnapshot.headings.some(({ key }) => key === focusedOutlineKey);
    const projectionBasis = presentationRef.current;
    const projectionEvent: OutlinePresentationEvent = {
      focusInside,
      headingCount: sourceSnapshot.headings.length,
      proof: sourceSnapshot.proof,
      type: "projection",
    };
    const projectedPresentation = reduceOutlinePresentation(projectionBasis, projectionEvent).state;
    const stableFocusedRail =
      focusedElement === railRef.current && projectedPresentation.mode !== "PINNED";
    const generationHandoff = focusInside && !stableFocusedItem && !stableFocusedRail;
    if (generationHandoff) focusSurface();
    setRenderedSnapshot(sourceSnapshot);
    transition(
      { ...projectionEvent, focusInside: generationHandoff ? false : focusInside },
      projectionBasis,
    );
  }, [focusSurface, projectionPending, renderedSnapshot, sourceSnapshot, transition]);

  const clearHoverTimer = useCallback((): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  const clearLeaveTimer = useCallback((): void => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const finishInteraction = useCallback((): OutlinePresentationMode => {
    const current = snapshotRef.current;
    if (current === null || projectionPending) return transition({ type: "dismiss" });
    return transition({
      headingCount: current.headings.length,
      proof: current.proof,
      type: "interaction-finished",
    });
  }, [projectionPending, transition]);

  useEffect(
    () => () => {
      clearHoverTimer();
      clearLeaveTimer();
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
      if (touchOpeningTimer.current !== null) clearTimeout(touchOpeningTimer.current);
    },
    [clearHoverTimer, clearLeaveTimer],
  );

  useEffect(() => {
    if (presentation.mode !== "TRANSIENT_LATCHED") return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      finishInteraction();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [finishInteraction, presentation.mode]);

  if (snapshot === null || presentation.mode === "ABSENT") return null;

  const transient = presentation.mode !== "PINNED";
  const open = presentation.mode === "PINNED" || presentation.mode !== "TRANSIENT_CLOSED";

  const activate = (key: string, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const motion = prefersReducedMotion() ? "reduced" : "normal";
    if (!surface.activateOutline(key, motion)) return;
    if (!transient) return;
    finishInteraction();
    if (event.detail === 0) {
      suppressRailFocusOpen.current = true;
      queueMicrotask(() => railRef.current?.focus());
    }
  };

  const onPointerEnter = (_event: ReactPointerEvent<HTMLDivElement>): void => {
    clearLeaveTimer();
    if (presentationRef.current.mode !== "TRANSIENT_CLOSED") return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      transition({ type: "hover-intent" });
    }, HOVER_INTENT_MS);
  };

  const onPointerLeave = (_event: ReactPointerEvent<HTMLDivElement>): void => {
    clearHoverTimer();
    if (presentationRef.current.mode !== "TRANSIENT_HOVER") return;
    clearLeaveTimer();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      transition({ type: "pointer-leave" });
    }, HOVER_LEAVE_MS);
  };

  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    if (pendingTimer.current !== null) {
      clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      if (sourceSnapshot === null) {
        transition({ focusInside: false, preserveHysteresis: true, type: "invalidate" });
        setRenderedSnapshot(null);
        return;
      }
    }
    if (presentationRef.current.mode === "TRANSIENT_LATCHED") finishInteraction();
  };

  return (
    <Collapsible
      ref={rootRef}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!transient) return;
        if (!nextOpen && touchOpeningRail.current) return;
        if (nextOpen || presentationRef.current.mode === "TRANSIENT_HOVER") {
          transition({ type: "latch" });
        } else {
          const railFocused = document.activeElement === railRef.current;
          const nextMode = finishInteraction();
          if (railFocused && nextMode === "PINNED") queueMicrotask(focusSurface);
        }
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !transient || !open) return;
        event.preventDefault();
        const nextMode = finishInteraction();
        if (nextMode === "PINNED") {
          focusSurface();
        } else {
          suppressRailFocusOpen.current = true;
          queueMicrotask(() => railRef.current?.focus());
        }
      }}
      data-test="artifact-outline"
      data-mode={presentation.mode.toLowerCase()}
      className={`pointer-events-none flex max-h-full min-h-0 w-full flex-col items-end ${
        transient ? "justify-end" : ""
      }`}
    >
      {transient ? (
        <CollapsibleTrigger
          ref={railRef}
          onTouchEnd={() => {
            if (
              presentationRef.current.mode !== "TRANSIENT_CLOSED" &&
              presentationRef.current.mode !== "TRANSIENT_HOVER"
            ) {
              return;
            }
            touchOpeningRail.current = true;
            transition({ type: "latch" });
            if (touchOpeningTimer.current !== null) clearTimeout(touchOpeningTimer.current);
            touchOpeningTimer.current = setTimeout(() => {
              touchOpeningTimer.current = null;
              touchOpeningRail.current = false;
            }, 0);
          }}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={open ? "Close artifact outline" : "Open artifact outline"}
              data-test="artifact-outline-rail"
              onPointerDown={() => {
                pointerFocusingRail.current = true;
              }}
              onPointerUp={() => {
                pointerFocusingRail.current = false;
              }}
              onPointerCancel={() => {
                pointerFocusingRail.current = false;
              }}
              onFocus={() => {
                if (suppressRailFocusOpen.current) {
                  suppressRailFocusOpen.current = false;
                  return;
                }
                if (pointerFocusingRail.current) {
                  pointerFocusingRail.current = false;
                  return;
                }
                transition({ type: "latch" });
              }}
              style={{ width: `${ARTIFACT_OUTLINE_POLICY.railInsetPx}px` }}
              className="pointer-events-auto h-16 cursor-pointer rounded-none border border-ink-500 bg-ink-850/95 px-0 text-fg-muted shadow-[0_4px_16px_rgba(0,0,0,0.4)] hover:bg-ink-700 hover:text-fg-strong focus-visible:annot-outline"
            >
              <span className="size-3.5">
                <ListIcon />
              </span>
            </Button>
          }
        />
      ) : null}
      <CollapsibleContent
        data-test="artifact-outline-content"
        className={`pointer-events-auto min-h-0 w-full ${transient ? "mt-1" : "h-full"}`}
      >
        <OutlinePanel mode={presentation.mode} snapshot={snapshot} onActivate={activate} />
      </CollapsibleContent>
    </Collapsible>
  );
};
