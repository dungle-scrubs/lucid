import type { Anchor } from "../../src/anchors/anchor.ts";
import type { PayloadAnnotation } from "../../src/protocol/wire.ts";

/**
 * postMessage protocol between the chrome (parent document) and the overlay
 * (injected into the artifact iframe). The chrome owns all server I/O; the
 * overlay owns DOM targeting and highlight rendering on the surface.
 */

/** The annotation as the wire delivers it (src/protocol/wire.ts) - the chrome
 *  forwards it to the overlay unchanged, so the highlight message carries the
 *  same shape the server built. */
export type PayloadAnnotationLike = PayloadAnnotation;

/**
 * A composed-but-unsent annotation's anchor. The chrome sends these so the
 * overlay can paint the queued item in place (its "queued" lifecycle state),
 * keeping the left-panel card and its spot in the artifact visibly linked.
 */
export interface QueuedAnchorLike {
  readonly id: string;
  readonly target: Anchor;
}

/** overlay -> chrome */
export type OverlayMessage =
  | { readonly source: "lucid-overlay"; readonly type: "ready" }
  | { readonly source: "lucid-overlay"; readonly type: "target-picked"; readonly anchor: Anchor }
  | {
      readonly source: "lucid-overlay";
      readonly type: "annotation-hover";
      readonly id: string | null;
    }
  | { readonly source: "lucid-overlay"; readonly type: "annotation-activate"; readonly id: string }
  | { readonly source: "lucid-overlay"; readonly type: "selection-cleared" }
  /** Widest real child of the artifact body, measured inside the iframe. The
   *  chrome cannot measure it: the surface runs on an opaque origin (D-020), so
   *  `iframe.contentDocument` is null from the parent. */
  | { readonly source: "lucid-overlay"; readonly type: "content-width"; readonly width: number };

/** chrome -> overlay */
export type ChromeMessage =
  | {
      readonly source: "lucid-chrome";
      readonly type: "highlight";
      readonly annotations: readonly PayloadAnnotationLike[];
      readonly queued: readonly QueuedAnchorLike[];
      readonly pending: Anchor | null;
      /**
       * False puts the surface in read mode: the overlay paints nothing and
       * stops targeting, so the artifact reads as plain document. It still
       * receives the anchors above and repaints instantly when this flips back.
       */
      readonly showTargets: boolean;
    }
  | { readonly source: "lucid-chrome"; readonly type: "swap"; readonly html: string }
  | { readonly source: "lucid-chrome"; readonly type: "focus-annotation"; readonly id: string }
  | { readonly source: "lucid-chrome"; readonly type: "diff-show"; readonly html: string }
  | { readonly source: "lucid-chrome"; readonly type: "diff-goto"; readonly hunkId: string }
  | { readonly source: "lucid-chrome"; readonly type: "clear-pending" }
  /** Ask the overlay to measure the artifact's content width. */
  | { readonly source: "lucid-chrome"; readonly type: "measure-content" };

export const isOverlayMessage = (data: unknown): data is OverlayMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-overlay";

export const isChromeMessage = (data: unknown): data is ChromeMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-chrome";
