/**
 * Defines the pre-artifact overlay authority boundary. Mount code receives the
 * one-shot construction powers, while the live custom element retains only an
 * exact ownership classifier, root identity, and guarded update operation.
 * Outline extraction capabilities remain in browser-artifact-outline.ts.
 */

import type { TrustedOutlineCapabilities } from "./browser-artifact-outline.ts";

export interface TrustedOverlayHostHandle {
  readonly isOwned: (element: Element) => boolean;
  readonly overlayRoot: () => HTMLElement;
  readonly performOverlayUpdate: (element: HTMLElement) => void;
  /** The parent WindowProxy captured PRE-ARTIFACT. `window.parent` is a
   *  `[Replaceable]` global an artifact script reassigns to itself, then forges
   *  a chrome command to its own window (the guard's `e.source !== window.parent`
   *  passes) and silently redirects every genuine overlay->chrome reply into
   *  the artifact's own window. Reading THIS captured reference - never the
   *  live global - closes both directions (plan 04, M1.1, D-009). */
  readonly parentWindow: Window;
}

export interface TrustedOverlayMountCapabilities {
  readonly constructCustomElement: <ElementType extends HTMLElement>(
    elementClass: new () => ElementType,
  ) => ElementType;
  readonly defineCustomElement: (name: string, elementClass: CustomElementConstructor) => void;
  readonly installOverlay: (element: HTMLElement) => void;
}

/** Trusted DOM operations for swapping the artifact body (DF-3). Node import
 *  and head-style mutation run on intrinsics captured PRE-ARTIFACT, so a
 *  hostile artifact that patches `Document.prototype.importNode` or the head
 *  accessors cannot observe or redirect them onto overlay-owned nodes. Flat
 *  members of the bag, not a nested handle, so the bag stays one shape (D-005).
 *  Parsing and body traversal stay realm-local deliberately; only import and
 *  head mutation are captured. */
export interface TrustedOverlaySwapCapabilities {
  /** Clone a node from the parsed document into the live one through the
   *  captured `importNode`, not the realm's patchable global. */
  readonly importNode: <T extends Node>(node: T, deep: boolean) => T;
  /** Remove every existing artifact-tagged style/link from the live `<head>`
   *  (queried and removed through captured intrinsics). */
  readonly removeArtifactStyles: () => void;
  /** Clone the parsed style/link through the captured `importNode`, tag it as
   *  an artifact style, append it to the live `<head>`, and - for a linked
   *  sheet - fire the callback when it loads. */
  readonly appendArtifactStyle: (source: Element, onLinkedSheetLoad?: () => void) => void;
}

export type TrustedOverlayCapabilities = TrustedOutlineCapabilities &
  TrustedOverlayHostHandle &
  TrustedOverlayMountCapabilities &
  TrustedOverlaySwapCapabilities;

/**
 * Every capability name the pre-artifact bootstrap has to hand over, as one
 * value a compiler can check: `satisfies` fails here the moment a member is
 * renamed, added, or dropped from the interfaces above.
 *
 * The only production implementation is a JavaScript object literal inside a
 * template string in `src/server/inject.ts`, which tsc never parses, so
 * `bootOverlay(port, tag, capabilities)` is the sole typed seam between them
 * and it types the whole bag at once. `test/overlay-capability-contract.test.ts`
 * closes the gap by comparing that literal's keys against this list.
 */
const TRUSTED_OVERLAY_CAPABILITY_WITNESS = {
  allElements: true,
  ariaHidden: true,
  clientHeight: true,
  clientWidth: true,
  constructCustomElement: true,
  createMap: true,
  createWeakMap: true,
  defineCustomElement: true,
  hasActiveMotion: true,
  hidden: true,
  importNode: true,
  inert: true,
  installOverlay: true,
  isConnected: true,
  isLightDom: true,
  isOwned: true,
  isSettled: true,
  now: true,
  observeMutations: true,
  observeResize: true,
  observeStyleActivity: true,
  onDocumentLoad: true,
  onFontsSettled: true,
  onFrameDetach: true,
  onWindowResize: true,
  onWindowScroll: true,
  overlayRoot: true,
  parentElement: true,
  parentWindow: true,
  performOverlayUpdate: true,
  appendArtifactStyle: true,
  removeArtifactStyles: true,
  proofRealmTrusted: true,
  pseudoContent: true,
  rect: true,
  scheduleFrame: true,
  scheduleQuiet: true,
  scrollHeight: true,
  scrollWidth: true,
  style: true,
  styleRealmTrusted: true,
  tagName: true,
  text: true,
  viewport: true,
} as const satisfies Record<keyof TrustedOverlayCapabilities, true>;

export const TRUSTED_OVERLAY_CAPABILITY_KEYS: readonly string[] = Object.keys(
  TRUSTED_OVERLAY_CAPABILITY_WITNESS,
);
