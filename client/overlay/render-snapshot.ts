/**
 * Sanitizes the overlay's render snapshot over VALUES, with no DOM handle. The
 * overlay's reactive state (markers, focusedId, hover/section rects, pulse) is
 * set by trusted code, but the overlay shares the artifact's JS realm, so a
 * hostile script can assign `overlay.markers = …` between updates. This module
 * is the render-time gate: every field is re-derived from its raw value into a
 * bounded, finite, typed snapshot, and the marker list passes the rect budget
 * (complete-or-absent - {@link enforceMarkerRectBudget}).
 *
 * Keeping it pure over values makes the whole render surface unit-testable with
 * literals instead of a mounted overlay.
 */

import { enforceMarkerRectBudget, type Marker, type MarkerState, type Rect } from "./markers.ts";

export interface OverlayRenderSnapshot {
  readonly focusedId: string | null;
  readonly hoverRect: Rect | null;
  readonly markers: readonly Marker[];
  readonly sectionPulse: number;
  readonly sectionRect: Rect | null;
}

/** Raw, untrusted render state (the overlay's reactive fields, as `unknown`). */
export interface RawRenderSnapshot {
  readonly focusedId: unknown;
  readonly hoverRect: unknown;
  readonly markers: unknown;
  readonly sectionPulse: unknown;
  readonly sectionRect: unknown;
}

/** A hostile payload must not turn one render into an unbounded walk. */
const MARKER_LIMIT = 2_000;
const RECT_PER_MARKER_LIMIT = 64;
const ID_LIMIT = 256;

const MARKER_STATES: ReadonlySet<MarkerState> = new Set([
  "committed",
  "decision",
  "pending",
  "queued",
]);

const finiteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const rect = (value: unknown): Rect | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Rect>;
  return {
    height: finiteNumber(candidate.height),
    left: finiteNumber(candidate.left),
    top: finiteNumber(candidate.top),
    width: finiteNumber(candidate.width),
  };
};

const sanitizeMarkers = (rawMarkers: unknown): Marker[] => {
  if (!Array.isArray(rawMarkers)) return [];
  const markers: Marker[] = [];
  const limit = Math.min(rawMarkers.length, MARKER_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    const candidate = rawMarkers[index] as Partial<Marker> | undefined;
    if (typeof candidate !== "object" || candidate === null) continue;
    const state = candidate.state as MarkerState;
    if (!MARKER_STATES.has(state)) continue;
    const rawRects = Array.isArray(candidate.rects) ? candidate.rects : [];
    const rects: Rect[] = [];
    for (
      let rectIndex = 0;
      rectIndex < Math.min(rawRects.length, RECT_PER_MARKER_LIMIT);
      rectIndex += 1
    ) {
      const captured = rect(rawRects[rectIndex]);
      if (captured !== null) rects.push(captured);
    }
    markers.push({
      id: typeof candidate.id === "string" ? candidate.id.slice(0, ID_LIMIT) : "",
      index: Math.trunc(finiteNumber(candidate.index)),
      rects,
      stackIndex: Math.trunc(finiteNumber(candidate.stackIndex)),
      state,
    });
  }
  return markers;
};

/**
 * Derive a bounded, typed render snapshot from untrusted raw state. Any marker
 * list whose rects exceed the global budget drops to empty (no partial paint).
 * A throw from a poisonable getter degrades to an empty snapshot rather than a
 * half-rendered one.
 */
export const sanitizeRenderSnapshot = (raw: RawRenderSnapshot): OverlayRenderSnapshot => {
  try {
    const { markers } = enforceMarkerRectBudget(sanitizeMarkers(raw.markers));
    return {
      focusedId: typeof raw.focusedId === "string" ? raw.focusedId.slice(0, ID_LIMIT) : null,
      hoverRect: rect(raw.hoverRect),
      markers,
      sectionPulse: Math.trunc(finiteNumber(raw.sectionPulse)),
      sectionRect: rect(raw.sectionRect),
    };
  } catch {
    return { focusedId: null, hoverRect: null, markers: [], sectionPulse: 0, sectionRect: null };
  }
};
