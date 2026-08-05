import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverPositioner } from "./ui/popover.tsx";
import { useSession } from "./context.tsx";
import type { CopyPopoverEvent, CopyPopoverState } from "./selection-copy.ts";

/**
 * The Copy Popover: the SOLE copy affordance for artifact text (D-001, D-002).
 *
 * A drag-select in the artifact posts a `selection-copy` (text + release point)
 * from the opaque-origin overlay; the chrome wiring translates that point into
 * parent-viewport coordinates and dispatches a `selection-copy` event into the
 * pure reducer (`nextCopyPopoverState`). This component is the thin React layer
 * over that state: it anchors the Popover at the translated point via a
 * VirtualElement (spike A-001), writes the clipboard on a Copy click, and wires
 * the dismissal sources (scroll, mode-toggle, swap, geometry-change,
 * outside-click) back into the reducer. The lifecycle TABLE lives in the
 * reducer; this owns only the DOM/React glue (D-004, D-018).
 *
 * Clipboard: `navigator.clipboard.writeText` runs on the Copy click's user
 * gesture in a secure context (the viewer is served on 127.0.0.1), which is
 * sufficient in the real `--app`. A rejection (a stricter engine) surfaces a
 * brief "Copy failed" state instead of a silent close, so the selection stays
 * one click away (RFC Error Handling).
 */

/**
 * The Lucide `copy` glyph (AGENTS.md: every icon is a Lucide icon, inline).
 * Two stacked rounded rects - the clipboard's paper and its back.
 */
const CopyIcon = (): React.ReactElement => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

export type CopyPopoverDispatch = (event: CopyPopoverEvent) => void;

/**
 * The Popover itself. Rendered only while `state` is open; the dismissal
 * effects below run on every render so a transition fires even as the open
 * state is about to flip to null.
 */
export const CopyPopover = ({
  state,
  dispatch,
}: {
  readonly state: CopyPopoverState;
  readonly dispatch: CopyPopoverDispatch;
}) => {
  // Dismissal sources that are React-observable from the session store:
  //  - mode-toggle: `showTargets` flipping (the crosshair). Copy is
  //    mode-independent to OFFER, but a mode change mid-Popover means the
  //    surface's whole posture changed, so the Popover dismisses rather than
  //    anchor to a stale release point.
  //  - swap: the artifact version changing (a live reload landed, or a
  //    historical version view opened/closed). The selection was made against
  //    the OLD document; keeping the Popover open would offer to copy text that
  //    may no longer exist.
  const showTargets = useSession((s) => s.showTargets);
  const version = useSession((s) => s.version);
  const viewingVersion = useSession((s) => s.viewingVersion);

  // Stable per-mount refs for the previous values, so the effect fires only on
  // an actual CHANGE (not every render the Popover is open).
  const prevShowTargets = useRef(showTargets);
  const prevSwapKey = useRef(`${version}:${viewingVersion ?? ""}`);
  useEffect(() => {
    if (prevShowTargets.current !== showTargets) {
      prevShowTargets.current = showTargets;
      dispatch({ kind: "mode-toggle" });
    }
    const swapKey = `${version}:${viewingVersion ?? ""}`;
    if (prevSwapKey.current !== swapKey) {
      prevSwapKey.current = swapKey;
      dispatch({ kind: "swap" });
    }
  }, [showTargets, version, viewingVersion, dispatch]);

  // Scroll: a NON-capture window listener, deliberately. A document scroll
  // moves the iframe - and with it the anchored release point - so it
  // dismisses (RFC: dismiss when the anchor moves). Element scrolls do not
  // bubble, so inner scrolls (the review panel, the thread viewport) never
  // reach this listener; capture-phase would catch them all, and the panel
  // column scrolling the annotation composer into view on the SAME
  // drag-select would dismiss the Popover the frame it opened. Scrolls
  // INSIDE the opaque-origin artifact are invisible to the parent either
  // way; covering those needs the overlay to report them (not done yet).
  useEffect(() => {
    const onScroll = (): void => dispatch({ kind: "scroll" });
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, [dispatch]);

  // A failed clipboard write surfaces a brief "Copy failed" state. Reset it
  // whenever a NEW selection opens the Popover, so the failure does not bleed
  // across selections. Reading `state` here (not just keying on it) is what
  // makes the reset fire on each new open.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (state !== null) setFailed(false);
  }, [state]);

  const onCopy = useCallback(async (): Promise<void> => {
    if (state === null) return;
    try {
      await navigator.clipboard.writeText(state.text);
      dispatch({ kind: "copy-click" });
    } catch {
      setFailed(true);
    }
  }, [state, dispatch]);

  // The VirtualElement anchor (spike A-001): Base UI's Positioner accepts this
  // and positions against a coordinate with no real trigger element. The rect
  // is the zero-size translated release point; the Popover sits ABOVE it
  // (Medium-style), and collision handling flips it below when there is no
  // room above.
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => state?.anchorRect ?? ZERO_RECT }),
    [state],
  );

  if (state === null) return null;

  return (
    <Popover
      open
      // Base UI fires onOpenChange(false) on outside-click; that is the
      // `click-away` dismissal. Internal clicks (the Copy button) do not.
      onOpenChange={(open) => {
        if (!open) dispatch({ kind: "click-away" });
      }}
    >
      <PopoverPositioner
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ side: "flip", align: "shift" }}
      >
        <PopoverContent
          data-test="copy-popover"
          className="flex min-w-[96px] items-center"
          // A mouse-driven selection Popover must not grab focus: the same
          // targeting-mode drag opens the annotation composer, whose autofocus
          // this would fight (and whose focus-scroll dismissed the Popover
          // before the reader ever saw it). The Copy button stays clickable;
          // it just never steals the keyboard.
          initialFocus={false}
        >
          <button
            type="button"
            data-test="copy-popover-copy"
            onClick={() => {
              void onCopy();
            }}
            disabled={failed}
            className="inline-flex w-full items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12px] text-fg outline-none hover:bg-ink-600 hover:text-fg-strong focus-visible:bg-ink-600 disabled:cursor-default disabled:text-destructive"
          >
            <CopyIcon />
            {failed ? "Copy failed" : "Copy"}
          </button>
        </PopoverContent>
      </PopoverPositioner>
    </Popover>
  );
};

/** A zero-size rect at the viewport origin; the fallback only when there is no
 *  open state (the component returns null before rendering in that case, so
 *  this exists to satisfy the VirtualElement contract on the memo). */
const ZERO_RECT = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
