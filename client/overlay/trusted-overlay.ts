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
}

export interface TrustedOverlayMountCapabilities {
  readonly constructCustomElement: <ElementType extends HTMLElement>(
    elementClass: new () => ElementType,
  ) => ElementType;
  readonly defineCustomElement: (name: string, elementClass: CustomElementConstructor) => void;
  readonly installOverlay: (element: HTMLElement) => void;
}

export type TrustedOverlayCapabilities = TrustedOutlineCapabilities &
  TrustedOverlayHostHandle &
  TrustedOverlayMountCapabilities;

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
  performOverlayUpdate: true,
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
