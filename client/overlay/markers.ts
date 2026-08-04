/**
 * Owns the overlay's marker pipeline: continuous numbering, badge assignment,
 * corner cascade, and the render rect budget. Pure over values - it takes no
 * DOM handle - so the whole marker surface is unit-testable with rect literals
 * instead of a mounted overlay.
 *
 * The overlay resolves annotations and decisions to their client rects and
 * hands the resolved values to {@link computeMarkers}; the render-snapshot
 * sanitizer calls {@link enforceMarkerRectBudget} at render time. That budget
 * is the anti-hostile defense: an artifact script shares the overlay's JS realm
 * and can inflate the marker list, and crossing the budget drops the entire set
 * rather than painting a misleading partial one.
 */

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type MarkerState = "committed" | "queued" | "pending" | "decision";

export interface Marker {
  readonly id: string;
  /** Lifecycle state of the annotation this marker anchors; drives its style. */
  readonly state: MarkerState;
  /** 1-based number shared with the left-panel card; 0 = no badge (a pending
   *  spot, or a multi-target item's secondary spots). */
  readonly index: number;
  readonly rects: readonly Rect[];
  /** How many earlier badges land on this same corner. Annotating one element
   *  twice would otherwise stack badges exactly and hide all but the last, so
   *  each is stepped right into a cascade. */
  readonly stackIndex: number;
}

/** Horizontal step per cascaded badge - less than the badge width, so they
 *  overlap and read as a stack rather than a row. */
export const BADGE_STEP_PX = 13;

/**
 * A hostile highlight payload must not turn one render into an unbounded DOM
 * allocation. The snapshot is complete or absent: crossing the global budget
 * drops every marker instead of painting a misleading partial set. The
 * boundary is exclusive (`>`, not `>=`): exactly MAX_MARKER_RECTS renders.
 */
export const MAX_MARKER_RECTS = 512;

/** Id prefix of the in-flight (pending) composer anchor markers - one per
 *  collected spot, suffixed by position. */
const PENDING_ID = "__lucid_pending";

/** Resolved marker sources, in render order. Each target's rects are already
 *  resolved against the DOM by the caller; an empty rect list means that target
 *  does not resolve (it is dropped). */
export interface MarkerInput {
  /** Decision regions, read straight off the live document. Always unnumbered. */
  readonly decisions: readonly (readonly Rect[])[];
  /** Committed annotations in record order. `paints` false = a quiet-sent mark
   *  that skips the paint but STILL advances the number (the number belongs to
   *  the record, so hiding #1 must not renumber #2's badge). */
  readonly committed: readonly {
    readonly id: string;
    readonly paints: boolean;
    readonly targets: readonly (readonly Rect[])[];
  }[];
  /** Queued annotations, continuing the committed count exactly as the panel's
   *  timeline does. */
  readonly queued: readonly {
    readonly id: string;
    readonly targets: readonly (readonly Rect[])[];
  }[];
  /** In-flight composer anchors. Always unnumbered. */
  readonly pending: readonly (readonly Rect[])[];
}

/**
 * Number, badge and cascade the resolved marker sources into the rendered
 * marker list. One badge per annotation lands on its first RESOLVING target
 * (not positionally the first): a spot edited away drops out, but the item
 * keeps its badge - it is the click-to-jump handle and the card's number.
 * Two annotations on one element resolve to the same corner, so their badges
 * are stepped into a cascade keyed on that corner; unnumbered markers never
 * join the cascade (they draw no badge to offset).
 */
export const computeMarkers = (input: MarkerInput): Marker[] => {
  const markers: Omit<Marker, "stackIndex">[] = [];
  for (const rects of input.decisions) {
    if (rects.length > 0) {
      markers.push({ id: `decision_${markers.length}`, index: 0, rects, state: "decision" });
    }
  }
  const pushAll = (
    id: string,
    state: MarkerState,
    index: number,
    targets: readonly (readonly Rect[])[],
  ): void => {
    let badged = false;
    for (const rects of targets) {
      if (rects.length === 0) continue;
      markers.push({ id, index: badged ? 0 : index, rects, state });
      badged = true;
    }
  };
  let number = 0;
  for (const annotation of input.committed) {
    number += 1; // per annotation, never per target: the badge matches the card's number
    if (!annotation.paints) continue;
    pushAll(annotation.id, "committed", number, annotation.targets);
  }
  input.queued.forEach((queued, index) => {
    pushAll(queued.id, "queued", number + index + 1, queued.targets);
  });
  input.pending.forEach((rects, index) => {
    if (rects.length > 0) {
      markers.push({ id: `${PENDING_ID}_${index}`, index: 0, rects, state: "pending" });
    }
  });

  const perCorner = new Map<string, number>();
  return markers.map((marker) => {
    const first = marker.rects[0];
    if (first === undefined || marker.index === 0) return { ...marker, stackIndex: 0 };
    const corner = `${Math.round(first.left)}:${Math.round(first.top)}`;
    const stackIndex = perCorner.get(corner) ?? 0;
    perCorner.set(corner, stackIndex + 1);
    return { ...marker, stackIndex };
  });
};

export interface MarkerBudgetResult {
  readonly markers: readonly Marker[];
  readonly budgetExceeded: boolean;
}

/**
 * Enforce the global rendered-rect budget. Rects accumulate across every
 * marker; the moment the running total exceeds the limit the whole set is
 * dropped (no partial paint). An empty input also produces no markers but is
 * distinguished from a budget drop by `budgetExceeded: false`.
 */
export const enforceMarkerRectBudget = (
  markers: readonly Marker[],
  limit: number = MAX_MARKER_RECTS,
): MarkerBudgetResult => {
  let total = 0;
  for (const marker of markers) {
    total += marker.rects.length;
    if (total > limit) return { budgetExceeded: true, markers: [] };
  }
  return { budgetExceeded: false, markers };
};
