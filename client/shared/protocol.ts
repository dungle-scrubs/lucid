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
  /** Every spot a cmd-collected item covers; `target` is always the first.
   *  Absent on a single-target item (and from older chromes). */
  readonly targets?: readonly Anchor[];
}

/** overlay -> chrome */
export type OverlayMessage =
  | { readonly source: "lucid-overlay"; readonly type: "ready" }
  | {
      readonly source: "lucid-overlay";
      readonly type: "target-picked";
      readonly anchor: Anchor;
      /** Held modifier keys at pick time (additive - an old overlay omits it).
       *  The CHROME owns what they mean: meta collects into one draft, shift
       *  pins onto the open question's answer. The overlay only reports. */
      readonly modifiers?: { readonly meta: boolean; readonly shift: boolean };
    }
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
  | { readonly source: "lucid-overlay"; readonly type: "content-width"; readonly width: number }
  /** Every `data-lucid-id` present in the current artifact. The chrome can't see
   *  the artifact DOM (opaque origin), so the overlay reports it: a section
   *  permalink in chat is a live chip while its id is in this set, and degrades
   *  to plain text once it isn't. Republished on load and every swap. */
  | {
      readonly source: "lucid-overlay";
      readonly type: "section-ids";
      readonly ids: readonly string[];
    };

/** chrome -> overlay */
export type ChromeMessage =
  | {
      readonly source: "lucid-chrome";
      readonly type: "highlight";
      readonly annotations: readonly PayloadAnnotationLike[];
      readonly queued: readonly QueuedAnchorLike[];
      readonly pending: Anchor | null;
      /** Every spot of a cmd-collected draft, first entry == `pending`. An
       *  overlay that predates it paints `pending` alone (additive). */
      readonly pendingList?: readonly Anchor[];
      /**
       * False puts the surface in read mode: the overlay paints nothing and
       * stops targeting, so the artifact reads as plain document. It still
       * receives the anchors above and repaints instantly when this flips back.
       */
      readonly showTargets: boolean;
    }
  | { readonly source: "lucid-chrome"; readonly type: "swap"; readonly html: string }
  | { readonly source: "lucid-chrome"; readonly type: "focus-annotation"; readonly id: string }
  /** Focus a mark AND bring it into view. `focus-annotation` only lights the
   *  mark where it already is (pointer hover); this is the keyboard "open" -
   *  the reader is not looking at the surface, so it must scroll there. */
  | { readonly source: "lucid-chrome"; readonly type: "reveal-annotation"; readonly id: string }
  | { readonly source: "lucid-chrome"; readonly type: "reveal-section"; readonly lucidId: string }
  | { readonly source: "lucid-chrome"; readonly type: "request-section-ids" }
  | { readonly source: "lucid-chrome"; readonly type: "diff-show"; readonly html: string }
  | { readonly source: "lucid-chrome"; readonly type: "diff-goto"; readonly hunkId: string }
  | { readonly source: "lucid-chrome"; readonly type: "clear-pending" }
  /** Ask the overlay to measure the artifact's content width. */
  | { readonly source: "lucid-chrome"; readonly type: "measure-content" }
  /**
   * Which palette the artifact renders in. The DECISION is the human's and
   * belongs to the tool, not the document: an artifact must render identically
   * from disk, offline, so it may not carry a toggle or its persisted state
   * (see the lucid-design skill). Lucid holds the preference and tells every
   * open artifact at once.
   */
  | {
      readonly source: "lucid-chrome";
      readonly type: "theme";
      readonly theme: "light" | "dark";
    };

export const isOverlayMessage = (data: unknown): data is OverlayMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-overlay";

export const isChromeMessage = (data: unknown): data is ChromeMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-chrome";
