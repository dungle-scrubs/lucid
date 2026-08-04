/**
 * Owns connected-element validation, motion-aware scrolling, section emphasis,
 * and generation-correlated AO-002 invalidation for every section reveal.
 * DOM discovery, projection lifecycle, and focus movement stay with callers.
 * This boundary keeps permalink and outline activation behavior identical.
 */

import {
  type OutlineActivation,
  type OutlineActivationHealth,
  type OutlineMotionPreference,
  type OutlineProjection,
  resolveOutlineActivation,
} from "../shared/artifact-outline.ts";

/** How far below the viewport's top edge a revealed heading comes to rest.
 *  Roughly one eyebrow line plus its spacing, so the kicker above a heading
 *  arrives with it instead of being scrolled past. */
const REVEAL_TOP_INSET_PX = 72;

export interface RevealInvalidation extends Omit<OutlineActivationHealth, "reason"> {
  readonly code: "AO-002";
  readonly reason: "disconnected-heading" | "stale-generation" | "unknown-key";
}

export interface EmphasisEnvironment {
  readonly clearEmphasis: () => void;
  readonly markEmphasis?: (element: Element | null) => void;
}

export interface RevealEnvironment extends EmphasisEnvironment {
  readonly invalidate?: (record: RevealInvalidation) => void;
}

export const emphasizeElement = (element: Element, environment: EmphasisEnvironment): void => {
  environment.clearEmphasis();
  environment.markEmphasis?.(element);
};

export const revealElement = (
  element: Element,
  motion: OutlineMotionPreference,
  environment: RevealEnvironment,
  generation = 0,
): boolean => {
  if (!element.isConnected) {
    environment.invalidate?.({
      code: "AO-002",
      generation,
      occurrenceCount: 1,
      reason: "disconnected-heading",
    });
    return false;
  }
  emphasizeElement(element, environment);
  // `start`, not `center`: a heading reached from the outline is the top of
  // what you came to read, so the section should open BELOW it. Centring put
  // the heading halfway down and filled the upper half with the section
  // already left behind. The inset keeps it off the very edge, so the eyebrow
  // line above a heading stays visible; `scroll-margin-top` is what
  // `scrollIntoView` honours for that, and is inert for everything else.
  const behavior = motion === "reduced" ? "instant" : "smooth";
  // The inset cannot ride on the element's own `scroll-margin-top`: writing a
  // style onto the artifact is a mutation of the document the outline runtime
  // watches, and it invalidates that runtime's geometry proof (measured - the
  // proof never completes again after one reveal). Scrolling the view to an
  // absolute position leaves the artifact untouched and lands the heading in
  // the same place, in one animation rather than a jump and a correction.
  const view = element.ownerDocument?.defaultView ?? null;
  if (view) {
    const top = element.getBoundingClientRect().top + view.scrollY - REVEAL_TOP_INSET_PX;
    view.scrollTo({ behavior, top: Math.max(0, top) });
  } else {
    element.scrollIntoView({ behavior, block: "start" });
  }
  return true;
};

export const revealOutlineActivation = (
  projection: OutlineProjection,
  activation: OutlineActivation,
  elementByKey: (key: string) => Element | null,
  motion: OutlineMotionPreference,
  environment: RevealEnvironment,
): boolean => {
  const resolution = resolveOutlineActivation(projection, activation);
  if (!resolution.accepted) {
    environment.invalidate?.(resolution.health);
    return false;
  }
  const element = elementByKey(resolution.key);
  if (element === null) {
    environment.invalidate?.({
      code: "AO-002",
      generation: projection.generation,
      occurrenceCount: 1,
      reason: "disconnected-heading",
    });
    return false;
  }
  return revealElement(element, motion, environment, projection.generation);
};
