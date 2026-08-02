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

export interface RevealInvalidation extends Omit<OutlineActivationHealth, "reason"> {
  readonly code: "AO-002";
  readonly reason: "disconnected-heading" | "stale-generation" | "unknown-key";
}

export interface EmphasisEnvironment {
  readonly clearEmphasis: () => void;
  readonly ensureStyles: () => void;
  readonly markEmphasis?: (element: Element | null) => void;
}

export interface RevealEnvironment extends EmphasisEnvironment {
  readonly invalidate: (record: RevealInvalidation) => void;
}

export const emphasizeElement = (element: Element, environment: EmphasisEnvironment): void => {
  environment.ensureStyles();
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
    environment.invalidate({
      code: "AO-002",
      generation,
      occurrenceCount: 1,
      reason: "disconnected-heading",
    });
    return false;
  }
  emphasizeElement(element, environment);
  element.scrollIntoView({
    behavior: motion === "reduced" ? "instant" : "smooth",
    block: "center",
  });
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
    environment.invalidate(resolution.health);
    return false;
  }
  const element = elementByKey(resolution.key);
  if (element === null) {
    environment.invalidate({
      code: "AO-002",
      generation: projection.generation,
      occurrenceCount: 1,
      reason: "disconnected-heading",
    });
    return false;
  }
  return revealElement(element, motion, environment, projection.generation);
};
