/**
 * The inbound overlay-message dispatch (M2.4): the state application that lived
 * inline in Chrome.tsx's `window.message` listener, extracted as a pure
 * function of the message plus the surface/handlers it reaches.
 *
 * Owns: the per-type state application (ready, target-picked, hover,
 * content-width, annotation-activate, section-ids, selection-copy/collapsed).
 *
 * Does NOT own: `validateOverlayMessage` or `ownsSource` - the security
 * boundary (a forged payload from another frame is dropped before this runs)
 * stays with the surface, which owns the iframe. This is the testable seam for
 * the dispatch; a host of DOM-coupled checks would defeat that.
 */

import { type CopyPopoverEvent, translateToViewport } from "./selection-copy.ts";
import { CHROME_MIN_WIDTH, defaultChromeWidth } from "./shell.ts";
import type { OverlayMessage } from "../shared/protocol.ts";

/** The width consumed by the divider between the artifact and the review. */
const DIVIDER_WIDTH = 5;

/** The surface methods an inbound message reaches: the overlay announcing
 *  readiness, and the frame rect a copy release is translated against. */
export interface InboundSurface {
  readonly markOverlayReady: () => void;
  readonly pushHighlights: () => void;
  readonly frameRect: () => DOMRect | null;
}

/** The chrome actions an inbound message drives. Declared here so the dispatch
 *  is unit-testable without the DOM or zustand. */
export interface InboundHandlers {
  readonly applyOverlayMessage: (
    msg: Extract<OverlayMessage, { readonly type: "target-picked" }>,
  ) => void;
  readonly setHoveredId: (id: string | null) => void;
  readonly setChromeWidth: (width: number) => void;
  readonly persistWidth: (width: number) => void;
  readonly scrollAnnotationIntoView: (id: string) => void;
  readonly setSections: (
    ids: readonly string[],
    added: readonly { readonly id: string; readonly inViewport: boolean }[] | undefined,
  ) => void;
  readonly dispatchCopy: (event: CopyPopoverEvent) => void;
}

/**
 * Apply one validated overlay message. `viewportWidth` is passed in (not read
 * off `window`) so a content-width sizing decision is unit-testable.
 */
export const applyInboundMessage = (
  msg: OverlayMessage,
  surface: InboundSurface,
  inbound: InboundHandlers,
  viewportWidth: number,
): void => {
  switch (msg.type) {
    case "ready":
      surface.markOverlayReady();
      surface.pushHighlights();
      return;
    case "target-picked":
      inbound.applyOverlayMessage(msg);
      return;
    case "annotation-hover":
      inbound.setHoveredId(msg.id);
      return;
    case "content-width": {
      // Size the surface to the content and give the rest to the review,
      // keeping the panel at or above its minimum. Fall back to the default
      // when there is nothing measurable.
      const width =
        msg.width <= 0
          ? defaultChromeWidth(viewportWidth)
          : Math.max(CHROME_MIN_WIDTH, viewportWidth - DIVIDER_WIDTH - msg.width);
      inbound.setChromeWidth(width);
      inbound.persistWidth(width);
      return;
    }
    case "annotation-activate":
      inbound.setHoveredId(msg.id);
      inbound.scrollAnnotationIntoView(msg.id);
      return;
    case "section-ids":
      inbound.setSections(msg.ids, msg.added);
      return;
    case "selection-copy": {
      // Translate the in-iframe release point into the PARENT viewport by
      // adding the iframe's own origin, then open the Copy Popover at a
      // zero-size rect there.
      const frameRect = surface.frameRect();
      if (frameRect === null) return;
      const point = translateToViewport(frameRect, msg.x, msg.y);
      inbound.dispatchCopy({
        kind: "selection-copy",
        text: msg.text,
        anchorRect: {
          left: point.x,
          top: point.y,
          width: 0,
          height: 0,
          right: point.x,
          bottom: point.y,
          x: point.x,
          y: point.y,
        },
      });
      return;
    }
    case "selection-collapsed":
      inbound.dispatchCopy({ kind: "collapse" });
      return;
    default:
      // pong (and future types) are not chrome state changes.
      return;
  }
};
