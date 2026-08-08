import {
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ARTIFACT_OUTLINE_POLICY,
  createOutlinePresentation,
  outlineHeadingNumber,
  type OutlinePresentationInput,
  type OutlinePresentationMode,
  type OutlinePresentationSendResult,
  type OutlinePresentationTimer,
  type OutlineSnapshot,
} from "../shared/artifact-outline.ts";
import { useSession, useSessionHandle } from "./context.tsx";
import { selectOutlinePending, selectOutlineSnapshot } from "./store.ts";
import { Button } from "./ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";

/** The resting rail's height (`h-16`) and the margin the panel keeps from the
 *  slot's edges. Named because the centering math below positions both. */
const RAIL_HEIGHT_PX = 64;
const RAIL_PANEL_GAP_PX = 4;

/**
 * The rail's hit area, grown past the tab that is drawn.
 *
 * The visible rail is a 16px strip - deliberately quiet, and correspondingly
 * hard to point at. This widens what RESPONDS without widening what shows:
 * half a tab-height of reach above and below, and a full tab-width to the
 * left, so the pointer opens the outline on approach rather than on a direct
 * hit. Everything is on the pseudo-element, so the tab's own geometry (which
 * the crispness tests pin to a device pixel) is untouched.
 */
const RAIL_HOVER_REACH =
  "before:absolute before:-inset-y-32 before:-left-7 before:right-0 before:content-['']";

/** Measured placement of the resting rail inside its slot. */
interface RailGeometry {
  /** The slot's own height - the room the centered panel has to fit in. */
  readonly slotHeight: number;
  /** The rail's offset from the slot's top, on a whole device pixel. */
  readonly top: number;
}

/**
 * The transient panel is centered ON the rail: its middle lines up with the
 * rail's middle, so it expands out of the thing the pointer is on rather than
 * dropping below it. Symmetry is what does the centering - the region is the
 * tallest box that fits inside the slot and is centered on the rail, and the
 * panel centers itself in that. Near the slot's top or bottom the region is
 * the short side doubled, so the panel gets smaller instead of drifting off
 * the rail or overflowing the slot.
 */
const transientRegion = (
  geometry: RailGeometry,
): { readonly height: number; readonly top: number } => {
  const center = geometry.top + RAIL_HEIGHT_PX / 2;
  const half = Math.max(0, Math.min(center, geometry.slotHeight - center) - RAIL_PANEL_GAP_PX);
  return { height: half * 2, top: center - half };
};

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

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface OutlinePanelProps {
  readonly mode: OutlinePresentationMode;
  readonly onActivate: (key: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly snapshot: OutlineSnapshot;
}

const OutlinePanel = ({ mode, onActivate, snapshot }: OutlinePanelProps) => {
  const manualNumber = /^\d+(\.\d+)*\.?\s+/u;
  return (
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
        {snapshot.headings.map((heading, index) => {
          const current = heading.key === snapshot.activeKey;
          const level = heading.level === 2 ? 2 : 1;
          const number = outlineHeadingNumber(snapshot.headings, index);
          const hasManualNumber = manualNumber.test(heading.label);
          const showNumber = number !== null && !hasManualNumber;
          return (
            <Button
              key={heading.key}
              type="button"
              variant="ghost"
              size="xs"
              aria-current={current ? "location" : undefined}
              aria-label={showNumber && number ? `${number} ${heading.label}` : heading.label}
              title={heading.label}
              data-test="artifact-outline-item"
              data-outline-key={heading.key}
              data-outline-level={level}
              onClick={(event) => onActivate(heading.key, event)}
              className={`flex h-7 w-full cursor-pointer justify-start rounded-none text-left text-[11px] font-normal text-fg-muted hover:bg-ink-700 hover:text-fg-strong focus-visible:annot-outline aria-[current=location]:bg-ink-700 aria-[current=location]:text-accent-bright ${
                level === 2
                  ? "pl-6 pr-2 text-[10px] text-steel-300 before:mr-2 before:h-px before:w-2 before:shrink-0 before:bg-ink-600 before:content-['']"
                  : "px-2"
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                {showNumber && number ? (
                  <span className="shrink-0 tabular-nums text-steel-400">{number}</span>
                ) : null}
                <span className="truncate">{heading.label}</span>
              </span>
            </Button>
          );
        })}
      </nav>
    </div>
  );
};

interface OutlineView {
  readonly mode: OutlinePresentationMode;
  readonly snapshot: OutlineSnapshot | null;
}

/**
 * The outline's chrome adapter. The interaction machine
 * ({@link createOutlinePresentation}, DOM- and clock-free) owns the modes,
 * timers, pointer/focus/touch ordering, and which snapshot is rendered; this
 * component is the thin realm-touching half. It feeds the machine DOM events,
 * applies the effects the machine returns (focus handoffs, timer arms and
 * cancels), and renders the mode and snapshot the machine settles on.
 *
 * Every effect is applied synchronously in the same task as the `send` that
 * produced it - a deferred focus-rail is exactly the window in which Escape's
 * close could be re-opened by its own focus, so the adapter does not defer it.
 */
export const ArtifactOutline = () => {
  const sourceSnapshot = useSession(selectOutlineSnapshot);
  const projectionPending = useSession(selectOutlinePending);
  const { surface } = useSessionHandle();

  const machineRef = useRef<ReturnType<typeof createOutlinePresentation> | null>(null);
  if (machineRef.current === null) machineRef.current = createOutlinePresentation();
  const machine = machineRef.current;

  // The machine's authoritative state, mirrored into React for rendering. It
  // is primed synchronously from the initial snapshot so the first paint is
  // already projected (no ABSENT flash when a snapshot is present at mount).
  const [view, setView] = useState<OutlineView>(() => {
    if (sourceSnapshot === null) return { mode: "ABSENT", snapshot: null };
    const result = machine.send(
      {
        focusInside: false,
        focusedKey: null,
        focusedRail: false,
        snapshot: sourceSnapshot,
        type: "snapshot-arrived",
      },
      0,
    );
    return { mode: result.mode, snapshot: result.snapshot };
  });

  // The three hysteresis timers the machine arms as `schedule` effects. One
  // owner (this map) replaces the three named refs; the machine decides what
  // arms and what cancels.
  const timers = useRef<Record<OutlinePresentationTimer, ReturnType<typeof setTimeout> | null>>({
    hover: null,
    leave: null,
    pending: null,
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLButtonElement | null>(null);

  const focusSurface = useCallback((): void => {
    rootRef.current?.closest<HTMLElement>('[data-test="surface-region"]')?.focus();
  }, []);

  const clearTimer = useCallback((timer: OutlinePresentationTimer): void => {
    const handle = timers.current[timer];
    if (handle !== null) {
      clearTimeout(handle);
      timers.current[timer] = null;
    }
  }, []);

  // sendRef lets a scheduled timer feed its event back through the latest send
  // without send having to reference itself in its own dependency array.
  const sendRef = useRef<(event: OutlinePresentationInput) => OutlinePresentationSendResult>(
    () => ({ mode: "ABSENT", snapshot: null, effects: [] }),
  );

  const armTimer = useCallback(
    (timer: OutlinePresentationTimer, ms: number, event: OutlinePresentationInput): void => {
      clearTimer(timer);
      timers.current[timer] = setTimeout(() => {
        timers.current[timer] = null;
        // The pending hold's focus is only known at fire time, so the adapter
        // refreshes it from the DOM when that one timer fires.
        sendRef.current(
          event.type === "pending-expired"
            ? {
                focusInside: rootRef.current?.contains(document.activeElement) === true,
                type: "pending-expired",
              }
            : event,
        );
      }, ms);
    },
    [clearTimer],
  );

  const send = useCallback(
    (event: OutlinePresentationInput): OutlinePresentationSendResult => {
      const result = machine.send(event, Date.now());
      // Effects are applied synchronously, in the same task as the state
      // change. focus-surface must land before the focused control unmounts
      // (a snapshot handoff or removal). focus-rail may re-enter send through
      // its own onFocus; that re-entry is a suppressed no-op (the machine marks
      // the focus it caused), so applying inline is safe and keeps the close and
      // its focus in the same task - no window for the panel to re-open.
      for (const effect of result.effects) {
        if (effect.kind === "focus-surface") {
          focusSurface();
        } else if (effect.kind === "focus-rail") {
          railRef.current?.focus();
        } else if (effect.kind === "schedule") {
          armTimer(effect.timer, effect.ms, effect.event);
        } else if (effect.kind === "cancel") {
          clearTimer(effect.timer);
        }
      }
      setView((prev) =>
        prev.mode === result.mode && prev.snapshot === result.snapshot
          ? prev
          : { mode: result.mode, snapshot: result.snapshot },
      );
      return result;
    },
    [armTimer, clearTimer, focusSurface, machine],
  );
  sendRef.current = send;

  // Where the resting rail sits: vertically centered in the slot, rounded so
  // its PAGE position lands on a whole CSS pixel. Measured rather than
  // `top: 50%` because the slot's top and height are fractional by design
  // (the half-pixel surface inset), and a rail on a half pixel renders a soft
  // border at 1x - the crispness the outline's geometry tests pin. Rounding
  // the local offset alone is not enough: the slot's own fractional top would
  // put an integral offset back onto a half pixel, so the compensation is
  // computed against the viewport. Null until the first measurement; the
  // pure-CSS fallback below keeps the pre-measurement paint sane.
  //
  // The slot's own height rides along because the transient panel is centered
  // on the rail, not hung below it: keeping it inside the slot needs both the
  // room above the rail's centre and the room below it.
  const [railGeometry, setRailGeometry] = useState<RailGeometry | null>(null);
  const railTop = railGeometry?.top ?? null;
  const transientNow = view.mode !== "PINNED" && view.mode !== "ABSENT";
  useLayoutEffect(() => {
    // The root only RENDERS once a snapshot exists: a mode flip that lands
    // before the snapshot finds no element, so the snapshot is a real input -
    // its arrival is what makes the first measurement possible.
    if (!transientNow || view.snapshot === null) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const measure = (): void => {
      const rect = root.getBoundingClientRect();
      const centered = rect.top + (rect.height - RAIL_HEIGHT_PX) / 2;
      const top = Math.max(0, Math.round(centered) - rect.top);
      // Same-reference return: the observer fires on every slot resize, and an
      // unchanged geometry must not re-render the panel mid-animation.
      setRailGeometry((previous) =>
        previous && previous.top === top && previous.slotHeight === rect.height
          ? previous
          : { slotHeight: rect.height, top },
      );
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
  }, [transientNow, view.snapshot]);

  // The snapshot lifecycle: the store's snapshot arriving or withdrawing is
  // the one place a projection event is built. focusInside (and which control
  // holds it) travel as the event's payload, never as component state.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const focusInside = rootRef.current?.contains(focused) === true;
    if (sourceSnapshot === null) {
      send({ focusInside, pending: projectionPending, type: "snapshot-withdrawn" });
      return;
    }
    const focusedKey = focused instanceof HTMLElement ? (focused.dataset.outlineKey ?? null) : null;
    send({
      focusInside,
      focusedKey,
      focusedRail: focused === railRef.current,
      snapshot: sourceSnapshot,
      type: "snapshot-arrived",
    });
  }, [projectionPending, send, sourceSnapshot]);

  useEffect(
    () => () => {
      for (const handle of Object.values(timers.current)) {
        if (handle !== null) clearTimeout(handle);
      }
    },
    [],
  );

  useEffect(() => {
    if (view.mode !== "TRANSIENT_LATCHED") return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      send({ type: "outside-press" });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [send, view.mode]);

  if (view.snapshot === null || view.mode === "ABSENT") return null;
  const snapshot = view.snapshot;

  const transient = view.mode !== "PINNED";
  const open = view.mode === "PINNED" || view.mode !== "TRANSIENT_CLOSED";

  const activate = (key: string, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const motion = prefersReducedMotion() ? "reduced" : "normal";
    if (!surface.activateOutline(key, motion)) return;
    send({ keyboard: event.detail === 0, type: "pick" });
  };

  return (
    <Collapsible
      ref={rootRef}
      open={open}
      onOpenChange={(nextOpen) => {
        const result = send({ open: nextOpen, type: "collapsible-change" });
        // Closing a latched panel that re-pins while the rail held focus hands
        // focus to the surface (pinned has no rail). The machine owns the mode;
        // this one focus move is the DOM concern it cannot decide alone.
        if (!nextOpen && result.mode === "PINNED" && document.activeElement === railRef.current) {
          focusSurface();
        }
      }}
      onPointerEnter={() => send({ type: "pointer-enter" })}
      onPointerLeave={() => send({ type: "pointer-exit" })}
      onBlur={(event: ReactFocusEvent<HTMLDivElement>) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        send({ type: "blur" });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (view.mode !== "TRANSIENT_HOVER" && view.mode !== "TRANSIENT_LATCHED") return;
        event.preventDefault();
        send({ type: "escape" });
      }}
      data-test="artifact-outline"
      data-mode={view.mode.toLowerCase()}
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
          onTouchEnd={() => send({ type: "rail-touch" })}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={open ? "Close artifact outline" : "Open artifact outline"}
              data-test="artifact-outline-rail"
              onPointerDown={() => send({ type: "rail-pointer-down" })}
              onPointerUp={() => send({ type: "rail-pointer-up" })}
              onPointerCancel={() => send({ type: "rail-pointer-up" })}
              onFocus={() => send({ type: "rail-focus" })}
              style={{
                top: railTop ?? `calc(50% - ${RAIL_HEIGHT_PX / 2}px)`,
                width: `${ARTIFACT_OUTLINE_POLICY.railInsetPx}px`,
              }}
              // !transition-none: the Button base carries transition-all,
              // which would ANIMATE `top` each time the centering compensation
              // updates - a rail gliding a quarter pixel is a rail off the
              // device-pixel grid for every frame of the glide.
              //
              // No z-index, and the reach is a pseudo-element: this button is
              // the HOVER ZONE, not just the tab you see. Painted above the
              // panel it swallowed clicks along the panel's right edge - two
              // section rows deep - so pointing at a section near its right
              // side latched the rail instead of jumping. Underneath, the
              // panel wins every pixel it covers.
              //
              // `before:` grows the zone well past the tab (a 16px-wide strip
              // is a small thing to find with a pointer) without moving the
              // tab or changing what is drawn: a pseudo-element is part of the
              // button for hit-testing, and it inherits the same z-order, so a
              // bigger zone costs the panel nothing.
              className={`!transition-none pointer-events-auto absolute right-0 h-16 cursor-pointer rounded-none border border-ink-500 bg-ink-850/95 px-0 text-fg-muted shadow-[0_4px_16px_rgba(0,0,0,0.4)] hover:bg-ink-700 hover:text-fg-strong focus-visible:annot-outline ${RAIL_HOVER_REACH}`}
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
        // Transient: an absolute region centered on the rail, so opening
        // displaces nothing and the panel arrives level with the pointer.
        // `justify-center` inside a region that is itself symmetric about the
        // rail is what puts the panel's middle on the rail's middle. Pointer
        // events stay off on the REGION (it is mostly empty space over the
        // artifact) and on on the panel, which re-enables them itself. Before
        // the first measurement the region falls back to the whole slot -
        // centered on the slot, which is where the rail is resting anyway.
        style={
          transient
            ? {
                // The rail's own column stays clear. The panel opens beside
                // it, not over it: covered, the rail stops being clickable the
                // moment its own hover opens the panel - and on touch, where
                // there is no hover at all, tapping the rail again is the ONLY
                // way to close. The hover zone still reaches under the panel
                // (see RAIL_HOVER_REACH); it simply loses those pixels to it.
                right: ARTIFACT_OUTLINE_POLICY.railInsetPx,
                ...(railGeometry ? transientRegion(railGeometry) : {}),
              }
            : undefined
        }
        className={`min-h-0 ${
          transient
            ? `pointer-events-none absolute left-0 flex flex-col justify-center ${
                railGeometry ? "" : "inset-y-0"
              }`
            : "pointer-events-auto h-full w-full"
        }`}
      >
        <OutlinePanel mode={view.mode} snapshot={snapshot} onActivate={activate} />
      </CollapsibleContent>
    </Collapsible>
  );
};
