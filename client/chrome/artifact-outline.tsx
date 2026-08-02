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

/** The resting rail's height (`h-16`) and the gap to the panel that opens
 *  under it. Named because the centering math below positions both. */
const RAIL_HEIGHT_PX = 64;
const RAIL_PANEL_GAP_PX = 4;

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
    // Only the TRANSIENT panel animates: it is the one that arrives, out of
    // the rail a human just pointed at. A pinned panel is simply there.
    className={`pointer-events-auto flex max-h-full min-h-0 w-full flex-col border border-ink-500 bg-ink-850/95 text-fg ${
      mode === "PINNED" ? "" : "outline-panel-enter shadow-[0_8px_24px_rgba(0,0,0,0.42)]"
    }`}
  >
    <div
      className={`flex h-7 shrink-0 items-center gap-1.5 border-b border-ink-600 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-muted ${
        mode === "PINNED" ? "" : "outline-labels-enter"
      }`}
    >
      <span className="size-3.5" aria-hidden="true">
        <ListIcon />
      </span>
      Sections
    </div>
    <nav
      aria-label="Artifact sections"
      className={`min-h-0 overflow-y-auto py-1 ${mode === "PINNED" ? "" : "outline-labels-enter"}`}
    >
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

  // Where the resting rail sits: vertically centered in the slot, rounded so
  // its PAGE position lands on a whole CSS pixel. Measured rather than
  // `top: 50%` because the slot's top and height are fractional by design
  // (the half-pixel surface inset), and a rail on a half pixel renders a soft
  // border at 1x - the crispness the outline's geometry tests pin. Rounding
  // the local offset alone is not enough: the slot's own fractional top would
  // put an integral offset back onto a half pixel, so the compensation is
  // computed against the viewport. Null until the first measurement; the
  // pure-CSS fallback below keeps the pre-measurement paint sane.
  const [railTop, setRailTop] = useState<number | null>(null);
  const transientNow = presentation.mode !== "PINNED" && presentation.mode !== "ABSENT";
  useLayoutEffect(() => {
    // The root only RENDERS once a snapshot exists: a mode flip that lands
    // before the snapshot finds no element, so the snapshot is a real input -
    // its arrival is what makes the first measurement possible.
    if (!transientNow || snapshot === null) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const measure = (): void => {
      const rect = root.getBoundingClientRect();
      const centered = rect.top + (rect.height - RAIL_HEIGHT_PX) / 2;
      setRailTop(Math.max(0, Math.round(centered) - rect.top));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    // The compensation goes stale if the slot MOVES without resizing - the
    // header's fonts settling shifts the whole surface region under a
    // same-sized slot. The region cannot move without resizing (the viewport
    // pins the column), so observing it catches what the root alone misses.
    const region = root.closest('[data-test="surface-region"]');
    if (region) observer.observe(region);
    return () => observer.disconnect();
  }, [transientNow, snapshot]);

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
      // Transient mode floats the rail at the slot's vertical CENTER, like a
      // side tab, with the panel opening below it. Both are absolutely
      // positioned so opening NEVER moves the rail: a trigger that jumps when
      // tapped is a trigger the tap's synthesized click then misses - the
      // click lands on the artifact and becomes an accidental pick. Pinned
      // mode keeps the top-anchored column.
      className={`pointer-events-none max-h-full min-h-0 w-full ${
        transient ? "relative h-full" : "flex flex-col items-end"
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
              style={{
                top: railTop ?? `calc(50% - ${RAIL_HEIGHT_PX / 2}px)`,
                width: `${ARTIFACT_OUTLINE_POLICY.railInsetPx}px`,
              }}
              // !transition-none: the Button base carries transition-all,
              // which would ANIMATE `top` each time the centering compensation
              // updates - a rail gliding a quarter pixel is a rail off the
              // device-pixel grid for every frame of the glide.
              className="!transition-none pointer-events-auto absolute right-0 h-16 cursor-pointer rounded-none border border-ink-500 bg-ink-850/95 px-0 text-fg-muted shadow-[0_4px_16px_rgba(0,0,0,0.4)] hover:bg-ink-700 hover:text-fg-strong focus-visible:annot-outline"
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
        // Transient: an absolute region from just under the centered rail to
        // the slot's bottom, so opening displaces nothing. Pointer events stay
        // off on the REGION (it is mostly empty space over the artifact) and
        // on on the panel, which re-enables them itself.
        style={transient ? { top: (railTop ?? 0) + RAIL_HEIGHT_PX + RAIL_PANEL_GAP_PX } : undefined}
        className={`min-h-0 w-full ${
          transient
            ? "pointer-events-none absolute inset-x-0 bottom-0"
            : "pointer-events-auto h-full"
        }`}
      >
        <OutlinePanel mode={presentation.mode} snapshot={snapshot} onActivate={activate} />
      </CollapsibleContent>
    </Collapsible>
  );
};
