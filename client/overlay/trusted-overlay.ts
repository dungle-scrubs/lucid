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
