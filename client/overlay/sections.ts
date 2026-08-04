/**
 * Section discovery and emphasis over a DOM-like seam. The overlay hands the
 * live artifact document and viewport in as functions; everything here is
 * testable with literal entries instead of a mounted document. The reveal and
 * pulse calls hand the matched element to reveal.ts (the shared emphasis seam),
 * so this module owns the section FINDING and viewport test, not the emphasis
 * mechanics themselves.
 */

import type { Rect } from "./markers.ts";
import { emphasizeElement, revealElement, type RevealEnvironment } from "./reveal.ts";
import type { OutlineMotionPreference } from "../shared/artifact-outline.ts";

export interface SectionEntry {
  readonly id: string;
  readonly element: Element;
  readonly rect: Rect;
}

export interface SectionDocument {
  /** Every `[data-lucid-id]` element in document order, with its id and rect. */
  readonly sections: () => readonly SectionEntry[];
  readonly viewport: () => { readonly height: number; readonly width: number };
}

/** Unique, non-empty section ids in document order (first occurrence wins). */
export const enumerateSectionIds = (document: SectionDocument): readonly string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const section of document.sections()) {
    if (section.id === "" || seen.has(section.id)) continue;
    seen.add(section.id);
    ids.push(section.id);
  }
  return ids;
};

/** The element for a section id, or undefined if it is not in the document. */
export const findSection = (document: SectionDocument, id: string): Element | undefined =>
  document.sections().find((section) => section.id === id)?.element;

/**
 * A section is in the viewport when it has not scrolled past any edge. Pure over
 * the rect and the viewport dimensions, so it is unit-testable with literals.
 */
export const isInViewport = (
  rect: Rect,
  viewport: { readonly height: number; readonly width: number },
): boolean =>
  rect.top + rect.height > 0 &&
  rect.left + rect.width > 0 &&
  rect.top < viewport.height &&
  rect.left < viewport.width;

/** For each added section id present in the document, its id and whether it is
 *  already in the viewport (so the chrome can decide scroll-vs-flash). */
export const addedSectionsInView = (
  document: SectionDocument,
  addedIds: ReadonlySet<string>,
): readonly { readonly id: string; readonly inViewport: boolean }[] => {
  const viewport = document.viewport();
  const reported = new Set<string>();
  const added: { id: string; inViewport: boolean }[] = [];
  for (const section of document.sections()) {
    if (section.id === "" || reported.has(section.id) || !addedIds.has(section.id)) continue;
    reported.add(section.id);
    added.push({ id: section.id, inViewport: isInViewport(section.rect, viewport) });
  }
  return added;
};

/** Reveal (scroll to) a section by id. No-op if the id is not in the document. */
export const revealSection = (
  document: SectionDocument,
  id: string,
  motion: OutlineMotionPreference,
  environment: RevealEnvironment,
): boolean => {
  const element = findSection(document, id);
  if (element === undefined) return false;
  return revealElement(element, motion, environment);
};

/** Emphasize a section in place (the no-scroll half of the update-location
 *  rule). No-op if the id is not in the document. */
export const pulseSection = (
  document: SectionDocument,
  id: string,
  environment: RevealEnvironment,
): void => {
  const element = findSection(document, id);
  if (element === undefined) return;
  emphasizeElement(element, environment);
};
