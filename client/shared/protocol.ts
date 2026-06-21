import type { Anchor } from "../../src/anchors/anchor.ts";

/**
 * postMessage protocol between the chrome (parent document) and the overlay
 * (injected into the artifact iframe). The chrome owns all server I/O; the
 * overlay owns DOM targeting and highlight rendering on the surface.
 */

export interface PayloadAnnotationLike {
  readonly id: string;
  readonly version: number;
  readonly resolved: boolean;
  readonly target: Anchor;
  readonly note: string;
  readonly at: string;
}

/** overlay -> chrome */
export type OverlayMessage =
  | { readonly source: "lucid-overlay"; readonly type: "ready" }
  | { readonly source: "lucid-overlay"; readonly type: "target-picked"; readonly anchor: Anchor }
  | { readonly source: "lucid-overlay"; readonly type: "selection-cleared" };

/** chrome -> overlay */
export type ChromeMessage =
  | {
      readonly source: "lucid-chrome";
      readonly type: "highlight";
      readonly annotations: readonly PayloadAnnotationLike[];
    }
  | { readonly source: "lucid-chrome"; readonly type: "swap"; readonly html: string }
  | { readonly source: "lucid-chrome"; readonly type: "focus-annotation"; readonly id: string }
  | { readonly source: "lucid-chrome"; readonly type: "clear-pending" };

export const isOverlayMessage = (data: unknown): data is OverlayMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-overlay";

export const isChromeMessage = (data: unknown): data is ChromeMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-chrome";
