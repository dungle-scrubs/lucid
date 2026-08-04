/**
 * Shared, DOM-free policy for the artifact outline protocol and presentation.
 *
 * Both iframe and chrome code depend on this module. Keeping the bounds and
 * state transitions here prevents either side from accepting a shape the
 * other side cannot safely produce.
 */

/**
 * This literal deliberately avoids Object.freeze(). The overlay bundle begins
 * evaluating after artifact-authored scripts, so invoking the realm's mutable
 * Object.freeze here would hand the policy object to hostile code. The bundle
 * does not export this binding to the artifact; readonly typing protects its
 * internal call sites without crossing that mutable intrinsic boundary.
 */
export const ARTIFACT_OUTLINE_POLICY = {
  outlineWidthPx: 240,
  railInsetPx: 18,
  paintClearancePx: 12,
  proofElementLimit: 2_000,
  proofTimeBudgetMs: 8,
  quietLayoutMs: 40,
  pinnedEnterClearancePx: 12,
  pinnedRetainClearancePx: 8,
  maxHeadings: 64,
  maxKeyCodeUnits: 128,
  maxExaminedLabelCodeUnits: 4_096,
  maxLabelCodeUnits: 240,
  maxAggregateExaminedLabelCodeUnits: 32_768,
  maxAggregateLabelCodeUnits: 8_192,
  maxSnapshotsPerSecond: 4,
  maxActiveKeysPerSecond: 10,
  maxPreferredWidthPx: 1_024,
  maxTextNodesPerHeading: 4_096,
  activeReadingThresholdPx: 80,
} as const;

/** A pre-trust timestamp sentinel that invokes no artifact-controlled intrinsic. */
export const OUTLINE_UNSEEN_TIMESTAMP_MS = -1 / 0;

type OutlineLabelParse =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly reason: "empty-label" | "label-length" };

const parseOutlineLabel = (text: string): OutlineLabelParse => {
  if (text.length > ARTIFACT_OUTLINE_POLICY.maxExaminedLabelCodeUnits) {
    return { ok: false, reason: "label-length" };
  }
  const label = text.replace(/\s+/gu, " ").trim();
  if (label.length > ARTIFACT_OUTLINE_POLICY.maxLabelCodeUnits) {
    return { ok: false, reason: "label-length" };
  }
  return label.length > 0 ? { label, ok: true } : { ok: false, reason: "empty-label" };
};

export const normalizeOutlineLabel = (text: string): string | null => {
  const parsed = parseOutlineLabel(text);
  return parsed.ok ? parsed.label : null;
};

export const isValidOutlineKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= ARTIFACT_OUTLINE_POLICY.maxKeyCodeUnits &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

export interface OutlineHeadingInput {
  readonly key: string;
  readonly text: string;
}

export interface OutlineHeading {
  readonly key: string;
  readonly label: string;
}

export type OutlineProjection =
  | { readonly kind: "absent"; readonly generation: number }
  | {
      readonly kind: "invalid";
      readonly generation: number;
      readonly health: OutlineHealth;
    }
  | {
      readonly kind: "complete";
      readonly generation: number;
      readonly headings: readonly OutlineHeading[];
    };

export type OutlineHealthCode = "AO-001" | "AO-002" | "AO-003" | "AO-004" | "AO-005";

export interface OutlineHealth {
  readonly code: OutlineHealthCode;
  readonly generation: number;
  readonly occurrenceCount: number;
  readonly reason?: string;
}

export interface OutlineSafeInsets {
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

export interface OutlineLayoutRequest {
  readonly generation: number;
  readonly preferredWidth: number;
  readonly safeInsets: OutlineSafeInsets;
}

export type OutlineLayoutMeasurement = Omit<OutlineLayoutRequest, "generation">;

export type OutlineMotionPreference = "normal" | "reduced";

export interface OutlineSnapshotProof extends OutlineProof {
  readonly reason: string;
}

export interface OutlineSnapshotPublication {
  readonly type: "outline-snapshot";
  readonly requestGeneration: number;
  readonly generation: number;
  readonly availability: "absent" | "complete";
  readonly headings: readonly OutlineHeading[];
  readonly activeKey: string | null;
  readonly proof: OutlineSnapshotProof;
  readonly health?: OutlineHealth;
}

export type OutlineRuntimePublication =
  | OutlineSnapshotPublication
  | {
      readonly type: "outline-active";
      readonly generation: number;
      readonly key: string | null;
    }
  | {
      readonly type: "outline-invalidated";
      readonly generation: number;
      readonly health: OutlineHealth;
    };

const invalidProjection = (generation: number, reason: string): OutlineProjection => ({
  generation,
  health: { code: "AO-001", generation, occurrenceCount: 1, reason },
  kind: "invalid",
});

export const projectOutlineHeadings = (
  generation: number,
  inputs: readonly OutlineHeadingInput[],
): OutlineProjection => {
  if (inputs.length < 2) return { generation, kind: "absent" };
  if (inputs.length > ARTIFACT_OUTLINE_POLICY.maxHeadings) {
    return invalidProjection(generation, "heading-count");
  }

  const keys = new Set<string>();
  const headings: OutlineHeading[] = [];
  let aggregateRawLabelLength = 0;
  let aggregateLabelLength = 0;
  for (const { key, text } of inputs) {
    if (!isValidOutlineKey(key)) return invalidProjection(generation, "invalid-key");
    if (keys.has(key)) return invalidProjection(generation, "duplicate-key");
    keys.add(key);
    aggregateRawLabelLength += text.length;
    if (aggregateRawLabelLength > ARTIFACT_OUTLINE_POLICY.maxAggregateExaminedLabelCodeUnits) {
      return invalidProjection(generation, "aggregate-label-length");
    }
    const parsed = parseOutlineLabel(text);
    if (!parsed.ok) return invalidProjection(generation, parsed.reason);
    aggregateLabelLength += parsed.label.length;
    if (aggregateLabelLength > ARTIFACT_OUTLINE_POLICY.maxAggregateLabelCodeUnits) {
      return invalidProjection(generation, "aggregate-label-length");
    }
    headings.push({ key, label: parsed.label });
  }
  return {
    generation,
    headings,
    kind: "complete",
  };
};

export interface OutlineHeadingPosition {
  readonly key: string;
  readonly top: number;
}

export const activeOutlineKey = (
  headings: readonly OutlineHeadingPosition[],
  threshold = ARTIFACT_OUTLINE_POLICY.activeReadingThresholdPx,
): string | null => {
  if (headings.length === 0) return null;
  let active = headings[0]?.key ?? null;
  for (const heading of headings) {
    if (heading.top <= threshold) active = heading.key;
  }
  return active;
};

export interface OutlineActivation {
  readonly generation: number;
  readonly key: string;
}

export interface OutlineActivationHealth extends OutlineHealth {
  readonly code: "AO-002";
  readonly reason: "stale-generation" | "unknown-key";
}

export type OutlineActivationResolution =
  | { readonly accepted: true; readonly key: string }
  | { readonly accepted: false; readonly health: OutlineActivationHealth };

export const resolveOutlineActivation = (
  projection: OutlineProjection,
  activation: OutlineActivation,
): OutlineActivationResolution => {
  const reason =
    activation.generation !== projection.generation
      ? "stale-generation"
      : projection.kind !== "complete" ||
          !projection.headings.some((heading) => heading.key === activation.key)
        ? "unknown-key"
        : null;
  if (reason === null) return { accepted: true, key: activation.key };
  return {
    accepted: false,
    health: {
      code: "AO-002",
      generation: projection.generation,
      occurrenceCount: 1,
      reason,
    },
  };
};

export type OutlinePresentationMode =
  | "ABSENT"
  | "PINNED"
  | "TRANSIENT_CLOSED"
  | "TRANSIENT_HOVER"
  | "TRANSIENT_LATCHED";

export type OutlinePresentationState =
  | {
      readonly mode: "ABSENT";
      /** Last settled mode only - no snapshot or geometry survives invalidation. */
      readonly priorMode?: "PINNED" | "TRANSIENT";
      readonly latchOrigin?: never;
    }
  | {
      readonly mode: Exclude<OutlinePresentationMode, "ABSENT" | "TRANSIENT_LATCHED">;
      readonly latchOrigin?: never;
      readonly priorMode?: never;
    }
  | {
      readonly mode: "TRANSIENT_LATCHED";
      readonly latchOrigin: "gutter" | "user";
      readonly priorMode?: never;
    };

export interface OutlineProof {
  readonly complete: boolean;
  readonly clearancePx: number;
}

export type OutlinePresentationEvent =
  | {
      readonly type: "projection";
      readonly headingCount: number;
      readonly proof: OutlineProof;
      readonly focusInside?: boolean;
    }
  | {
      readonly type: "interaction-finished";
      readonly headingCount: number;
      readonly proof: OutlineProof;
      readonly focusInside?: boolean;
    }
  | {
      readonly type: "invalidate";
      readonly focusInside?: boolean;
      /** Preserve only the last mode bit across a soft geometry reproof. */
      readonly preserveHysteresis?: boolean;
    }
  | { readonly type: "hover-intent" }
  | { readonly type: "pointer-leave" }
  | { readonly type: "latch" }
  | { readonly type: "activate" }
  | { readonly type: "dismiss" };

export interface OutlinePresentationResult {
  readonly state: OutlinePresentationState;
  readonly effects?: readonly ["focus-surface"];
}

const leaveForAbsent = (
  focusInside: boolean,
  priorMode?: "PINNED" | "TRANSIENT",
): OutlinePresentationResult => {
  const state: OutlinePresentationState =
    priorMode === undefined ? { mode: "ABSENT" } : { mode: "ABSENT", priorMode };
  return focusInside ? { effects: ["focus-surface"], state } : { state };
};

/**
 * The pure presentation-lattice transition: given a basis state and one
 * event, return the next state plus the side-effecting intent (today, only a
 * focus handoff). This is the speculative half of the outline machine - it
 * touches no clock, no DOM, and no snapshot store, so the interaction machine
 * (`createOutlinePresentation`) and its tests can peek at where an event would
 * take the lattice without committing to it.
 */
export const project = (
  state: OutlinePresentationState,
  event: OutlinePresentationEvent,
): OutlinePresentationResult => {
  if (event.type === "invalidate") {
    const priorMode = event.preserveHysteresis
      ? state.mode === "PINNED" || (state.mode === "ABSENT" && state.priorMode === "PINNED")
        ? "PINNED"
        : "TRANSIENT"
      : undefined;
    return leaveForAbsent(event.focusInside === true, priorMode);
  }

  if (event.type === "projection" || event.type === "interaction-finished") {
    if (event.headingCount < 2) return leaveForAbsent(event.focusInside === true);

    if (state.mode === "TRANSIENT_LATCHED" && event.type !== "interaction-finished") {
      return { state };
    }

    const threshold =
      state.mode === "PINNED" || (state.mode === "ABSENT" && state.priorMode === "PINNED")
        ? ARTIFACT_OUTLINE_POLICY.pinnedRetainClearancePx
        : ARTIFACT_OUTLINE_POLICY.pinnedEnterClearancePx;
    if (event.proof.complete && event.proof.clearancePx >= threshold) {
      return { state: { mode: "PINNED" } };
    }
    if (state.mode === "PINNED" && event.focusInside === true) {
      return { state: { latchOrigin: "gutter", mode: "TRANSIENT_LATCHED" } };
    }
    return { state: { mode: "TRANSIENT_CLOSED" } };
  }

  if (state.mode === "TRANSIENT_CLOSED") {
    if (event.type === "hover-intent") return { state: { mode: "TRANSIENT_HOVER" } };
    if (event.type === "latch") {
      return { state: { latchOrigin: "user", mode: "TRANSIENT_LATCHED" } };
    }
  }
  if (state.mode === "TRANSIENT_HOVER") {
    if (event.type === "latch") {
      return { state: { latchOrigin: "user", mode: "TRANSIENT_LATCHED" } };
    }
    if (event.type === "pointer-leave" || event.type === "activate") {
      return { state: { mode: "TRANSIENT_CLOSED" } };
    }
  }
  if (
    state.mode === "TRANSIENT_LATCHED" &&
    (event.type === "activate" || event.type === "dismiss")
  ) {
    return { state: { mode: "TRANSIENT_CLOSED" } };
  }
  return { state };
};

/**
 * Legacy alias for {@link project}, kept while the snapshot-validation suite
 * (which only checks that a valid proof pins the mode) migrates onto the
 * interaction machine. New code calls `project` or drives the machine through
 * `createOutlinePresentation().send`.
 */
export const reduceOutlinePresentation = project;

/**
 * Side effects the interaction machine asks its adapter (the React component)
 * to perform. The machine itself is DOM- and clock-free: it never calls
 * setTimeout or focuses an element. Instead it returns these intents, and the
 * adapter applies the ones that touch the realm.
 *
 * - `focus-surface` / `focus-rail`: move focus so it survives a mode change
 *   (focus was inside a control that is about to unmount, or the outline just
 *   closed and focus should return to the rail).
 * - `schedule(timer, ms, event)`: arm a deferred transition. The adapter starts
 *   a real timer; when it fires it feeds `event` back through `send`. This is
 *   how the hover/leave/pending hysteresis timers stop being component refs.
 * - `cancel(timer)`: clear a timer the adapter armed, because a later event
 *   superseded it (re-entering the rail cancels the pending close, a fresh
 *   snapshot cancels the pending reproof).
 */
export type OutlinePresentationTimer = "hover" | "leave" | "pending";

/**
 * The three hysteresis delays the interaction machine arms as `schedule`
 * effects. They live here - beside the machine, not in the React component -
 * because the component no longer owns a timer; it only applies the effect the
 * machine returns.
 */
export const OUTLINE_PRESENTATION_HOVER_INTENT_MS = 120;
export const OUTLINE_PRESENTATION_HOVER_LEAVE_MS = 180;
export const OUTLINE_PRESENTATION_PENDING_HOLD_MS = 500;

export type OutlinePresentationEffect =
  | { readonly kind: "focus-surface" }
  | { readonly kind: "focus-rail" }
  | {
      readonly kind: "schedule";
      readonly timer: OutlinePresentationTimer;
      readonly ms: number;
      readonly event: OutlinePresentationInput;
    }
  | { readonly kind: "cancel"; readonly timer: OutlinePresentationTimer };

/** The interaction machine's input. Grows by milestone as more of the React
 *  component's ad-hoc handling moves behind `send` (timers, then pointer/focus
 *  ordering, then snapshot selection). */
export type OutlinePresentationInput =
  | OutlinePresentationEvent
  | { readonly type: "pointer-enter" }
  | { readonly type: "pointer-exit" }
  | { readonly type: "rail-focus" }
  | { readonly type: "rail-pointer-down" }
  | { readonly type: "rail-pointer-up" }
  | { readonly type: "rail-touch" }
  | { readonly type: "escape" }
  | { readonly type: "collapsible-change"; readonly open: boolean }
  | { readonly type: "pick"; readonly keyboard: boolean }
  | { readonly type: "blur" }
  | { readonly type: "outside-press" }
  | {
      readonly type: "snapshot-arrived";
      readonly snapshot: OutlineSnapshot;
      readonly focusInside: boolean;
      /** Outline key of the focused item, if focus is on an item button. */
      readonly focusedKey?: string | null;
      /** Whether focus is on the resting rail. */
      readonly focusedRail?: boolean;
    }
  | {
      readonly type: "snapshot-withdrawn";
      readonly pending: boolean;
      readonly focusInside: boolean;
    }
  | { readonly type: "pending-expired"; readonly focusInside?: boolean };

export interface OutlinePresentationSendResult {
  readonly mode: OutlinePresentationMode;
  readonly snapshot: OutlineSnapshot | null;
  readonly effects: readonly OutlinePresentationEffect[];
}

export interface OutlinePresentationOptions {
  /** Seed the lattice at a known mode (tests reach arbitrary modes this way).
   *  Omit to start ABSENT. */
  readonly seed?: OutlinePresentationState;
  /** Seed the rendered snapshot (tests that assert snapshot selection). */
  readonly snapshot?: OutlineSnapshot | null;
}

/**
 * The outline's interaction machine: one owner for the presentation lattice,
 * the hover/leave/pending timers, the pointer/focus/touch ordering rules, and
 * which snapshot is currently rendered. It is DOM- and clock-free - every
 * realm touch is an {@link OutlinePresentationEffect} the adapter applies - so
 * the whole interaction surface is unit-testable with a fake clock and ordered
 * `send` calls instead of a mounted component.
 *
 * The pure half is {@link project}; this factory holds the stateful half.
 */
export const createOutlinePresentation = (
  options: OutlinePresentationOptions = {},
): {
  readonly send: (event: OutlinePresentationInput, nowMs: number) => OutlinePresentationSendResult;
} => {
  let presentation: OutlinePresentationState = options.seed ?? { mode: "ABSENT" };
  let renderedSnapshot: OutlineSnapshot | null = options.snapshot ?? null;
  // Logical pending-ness for the three timers. The adapter holds the real
  // handles; the machine tracks these so it can ask for a cancel when a later
  // event supersedes a timer it armed, and so it never arms one twice.
  let hoverPending = false;
  let leavePending = false;
  // Ordering bookkeeping that used to live as scattered component refs. The
  // machine owns it so the ordering is unit-testable as a sequence of `send`
  // calls rather than a race between DOM events and microtasks.
  // - pointerOnRail: a pointer is down on the rail, so a focus arriving now is a
  //   touch/mouse synthesis, not a keyboard focus that should open the panel.
  // - suppressNextRailFocus: the machine just returned focus to the rail itself
  //   (Escape); the focus event that causes is its own and must not re-open.
  // - touchOpening: a touch just opened the rail; the browser's synthesized
  //   close-click is the next collapsible-change and is suppressed.
  let pointerOnRail = false;
  let suppressNextRailFocus = false;
  let touchOpening = false;
  // Whether the pending-reproof hold timer is armed. Tracked so a fresh
  // snapshot can cancel it and so the hold arms at most once.
  let pendingPending = false;

  // Commit a lattice transition: adopt its settled state and append any lattice
  // effects (today only focus-surface) to the machine's effect list. One
  // helper replaces the repeated set-state-and-push-effects idiom at every
  // transition site.
  const commit = (
    effects: OutlinePresentationEffect[],
    result: OutlinePresentationResult,
  ): OutlinePresentationState => {
    presentation = result.state;
    for (const effect of result.effects ?? []) effects.push({ kind: effect });
    return result.state;
  };

  // Re-evaluate the lattice as the end of an interaction (blur, Escape, a close
  // click): re-pin if the current snapshot's proof still fits the gutter,
  // otherwise drop to transient-closed. A projection whose reproof is still in
  // flight (the pending hold is armed, or no snapshot is rendered yet) is NOT a
  // proof to re-pin against - it dismisses, matching the store's projectionPending
  // guard. Returns the settled state so callers branch on a value the closure
  // reassigned (an outer narrowing on `presentation` is stale).
  const finishInteraction = (effects: OutlinePresentationEffect[]): OutlinePresentationState =>
    renderedSnapshot !== null && !pendingPending
      ? commit(
          effects,
          project(presentation, {
            headingCount: renderedSnapshot.headings.length,
            proof: renderedSnapshot.proof,
            type: "interaction-finished",
          }),
        )
      : commit(effects, project(presentation, { type: "dismiss" }));

  const send = (event: OutlinePresentationInput, _nowMs: number): OutlinePresentationSendResult => {
    const effects: OutlinePresentationEffect[] = [];

    if (event.type === "pointer-enter") {
      // Entering always cancels a pending close; only a closed panel arms the
      // open-on-hover delay, and only if one is not already armed.
      if (leavePending) {
        effects.push({ kind: "cancel", timer: "leave" });
        leavePending = false;
      }
      if (presentation.mode === "TRANSIENT_CLOSED" && !hoverPending) {
        hoverPending = true;
        effects.push({
          kind: "schedule",
          timer: "hover",
          ms: OUTLINE_PRESENTATION_HOVER_INTENT_MS,
          event: { type: "hover-intent" },
        });
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "pointer-exit") {
      // Leaving cancels a pending open; only an open-on-hover panel arms the
      // close-on-leave delay. A closed panel that never opened arms nothing.
      if (hoverPending) {
        effects.push({ kind: "cancel", timer: "hover" });
        hoverPending = false;
      }
      if (presentation.mode === "TRANSIENT_HOVER" && !leavePending) {
        leavePending = true;
        effects.push({
          kind: "schedule",
          timer: "leave",
          ms: OUTLINE_PRESENTATION_HOVER_LEAVE_MS,
          event: { type: "pointer-leave" },
        });
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "rail-pointer-down") {
      pointerOnRail = true;
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }
    if (event.type === "rail-pointer-up") {
      pointerOnRail = false;
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "rail-focus") {
      // A focus we caused (Escape returning focus to the rail) is suppressed for
      // exactly one event. A focus that arrives while a pointer is down on the
      // rail is a touch/mouse synthesis, not a keyboard open. Only a genuine
      // keyboard focus latches the panel open.
      if (suppressNextRailFocus) {
        suppressNextRailFocus = false;
        return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
      }
      if (pointerOnRail) {
        pointerOnRail = false;
        return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
      }
      const focused = project(presentation, { type: "latch" });
      commit(effects, focused);
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "rail-touch") {
      // Touch has no hover: tapping the rail is the only way in. It latches from
      // closed or hover, and marks the open so the synthesized close-click is
      // suppressed below.
      if (presentation.mode === "TRANSIENT_CLOSED" || presentation.mode === "TRANSIENT_HOVER") {
        commit(effects, project(presentation, { type: "latch" }));
        touchOpening = true;
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "escape") {
      // Escape ends an open transient interaction. Re-pinning focuses the
      // surface (pinned has no rail); otherwise focus returns to the rail and
      // the machine suppresses its own focus so the panel does not re-open.
      if (presentation.mode === "TRANSIENT_HOVER" || presentation.mode === "TRANSIENT_LATCHED") {
        const settled = finishInteraction(effects);
        if (settled.mode === "PINNED") {
          effects.push({ kind: "focus-surface" });
        } else {
          suppressNextRailFocus = true;
          effects.push({ kind: "focus-rail" });
        }
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "pick") {
      // Activating a section ends a transient interaction (a pinned outline is
      // not driven by picks). A keyboard pick returns focus to the rail - which
      // only exists while the panel is transient-closed, not after a re-pin -
      // and the machine suppresses its own focus so the panel stays closed.
      if (presentation.mode !== "PINNED") {
        const settled = finishInteraction(effects);
        if (event.keyboard && settled.mode === "TRANSIENT_CLOSED") {
          suppressNextRailFocus = true;
          effects.push({ kind: "focus-rail" });
        }
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "outside-press") {
      // A pointer press outside a latched panel ends the interaction.
      if (presentation.mode === "TRANSIENT_LATCHED") finishInteraction(effects);
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "blur") {
      // Focus left the outline. A pending hold that loses focus exits early
      // (cancel the hold, drop to absent preserving priorMode, clear the held
      // snapshot); otherwise a latched interaction simply ends.
      if (pendingPending) {
        effects.push({ kind: "cancel", timer: "pending" });
        pendingPending = false;
        commit(
          effects,
          project(presentation, {
            focusInside: false,
            preserveHysteresis: true,
            type: "invalidate",
          }),
        );
        renderedSnapshot = null;
      } else if (presentation.mode === "TRANSIENT_LATCHED") {
        finishInteraction(effects);
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "collapsible-change") {
      // The rail trigger's toggle. Pinned is not driven by the trigger. A close
      // that is the synthesized echo of a touch-open is suppressed; an open (or
      // a toggle while hovering) latches; otherwise the interaction ends.
      if (presentation.mode !== "PINNED") {
        if (!event.open && touchOpening) {
          touchOpening = false;
        } else if (event.open || presentation.mode === "TRANSIENT_HOVER") {
          commit(effects, project(presentation, { type: "latch" }));
        } else {
          finishInteraction(effects);
        }
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "snapshot-arrived") {
      // A fresh snapshot cancels any armed hold. A stale generation (older or
      // equal to the one already rendered) is ignored; only a strictly newer
      // generation replaces the rendered snapshot and drives the projection.
      if (pendingPending) {
        effects.push({ kind: "cancel", timer: "pending" });
        pendingPending = false;
      }
      if (renderedSnapshot !== null && event.snapshot.generation <= renderedSnapshot.generation) {
        return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
      }
      const projectionEvent = {
        focusInside: event.focusInside,
        headingCount: event.snapshot.headings.length,
        proof: event.snapshot.proof,
        type: "projection" as const,
      };
      const projected = project(presentation, projectionEvent);
      // Focus survives if it is on an item that still exists, or on the rail
      // while the panel stays transient. Otherwise the snapshot change orphaned
      // focus, and it is handed to the surface before the lattice moves.
      const stableFocusedItem =
        event.focusedKey !== undefined &&
        event.focusedKey !== null &&
        event.snapshot.headings.some((heading) => heading.key === event.focusedKey);
      const stableFocusedRail = event.focusedRail === true && projected.state.mode !== "PINNED";
      const handoff = event.focusInside && !stableFocusedItem && !stableFocusedRail;
      renderedSnapshot = event.snapshot;
      if (handoff) {
        effects.push({ kind: "focus-surface" });
        commit(effects, project(presentation, { ...projectionEvent, focusInside: false }));
      } else {
        commit(effects, projected);
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "snapshot-withdrawn") {
      if (event.pending) {
        // A reproof is in flight: a new snapshot is expected. With focus inside
        // on a rendered snapshot, latch the gutter so focus and identity survive
        // the short hold; otherwise drop to absent preserving the prior mode so
        // the reproof snaps back to it.
        if (event.focusInside && renderedSnapshot !== null) {
          commit(
            effects,
            project(presentation, {
              focusInside: true,
              headingCount: renderedSnapshot.headings.length,
              proof: { clearancePx: 0, complete: false },
              type: "projection",
            }),
          );
          if (!pendingPending) {
            pendingPending = true;
            effects.push({
              kind: "schedule",
              timer: "pending",
              ms: OUTLINE_PRESENTATION_PENDING_HOLD_MS,
              event: { type: "pending-expired" },
            });
          }
        } else {
          if (pendingPending) {
            effects.push({ kind: "cancel", timer: "pending" });
            pendingPending = false;
          }
          commit(
            effects,
            project(presentation, {
              focusInside: false,
              preserveHysteresis: true,
              type: "invalidate",
            }),
          );
          renderedSnapshot = null;
        }
      } else {
        // A real loss, not a reproof: cancel any hold and hard-invalidate so the
        // next arrival must meet the full enter gate.
        if (pendingPending) {
          effects.push({ kind: "cancel", timer: "pending" });
          pendingPending = false;
        }
        commit(
          effects,
          project(presentation, { focusInside: event.focusInside, type: "invalidate" }),
        );
        renderedSnapshot = null;
      }
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    if (event.type === "pending-expired") {
      // The hold elapsed without a fresh snapshot: clear what was held and drop
      // to absent, preserving the prior mode across the soft reproof. The
      // adapter refreshes focusInside from the DOM when it fires this timer -
      // focus is the one payload known only at fire time - so it is optional
      // here and defaults to a safe no-handoff.
      pendingPending = false;
      renderedSnapshot = null;
      commit(
        effects,
        project(presentation, {
          focusInside: event.focusInside ?? false,
          preserveHysteresis: true,
          type: "invalidate",
        }),
      );
      return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
    }

    // A deferred transition firing clears the timer it owns, then runs the
    // lattice. (hover-intent clears hover; pointer-leave clears leave.)
    if (event.type === "hover-intent") hoverPending = false;
    else if (event.type === "pointer-leave") leavePending = false;

    commit(effects, project(presentation, event));
    return { mode: presentation.mode, snapshot: renderedSnapshot, effects };
  };

  return { send };
};

export type OutlineRateChannel = "snapshot" | "active-key";

export interface OutlineRateGate {
  readonly accept: (channel: OutlineRateChannel, nowMs: number) => boolean;
}

export const createOutlineRateGate = (): OutlineRateGate => {
  const accepted: Record<OutlineRateChannel, number[]> = { "active-key": [], snapshot: [] };
  const lastSeen: Record<OutlineRateChannel, number> = {
    "active-key": OUTLINE_UNSEEN_TIMESTAMP_MS,
    snapshot: OUTLINE_UNSEEN_TIMESTAMP_MS,
  };
  return {
    accept: (channel, nowMs) => {
      if (!Number.isFinite(nowMs) || nowMs < lastSeen[channel]) return false;
      lastSeen[channel] = nowMs;
      const timestamps = accepted[channel];
      while (timestamps[0] !== undefined && timestamps[0] <= nowMs - 1_000) timestamps.shift();
      const limit =
        channel === "snapshot"
          ? ARTIFACT_OUTLINE_POLICY.maxSnapshotsPerSecond
          : ARTIFACT_OUTLINE_POLICY.maxActiveKeysPerSecond;
      if (timestamps.length >= limit) return false;
      timestamps.push(nowMs);
      return true;
    },
  };
};

export interface OutlineSnapshot {
  readonly activeKey: string | null;
  readonly available: true;
  readonly generation: number;
  readonly headings: readonly OutlineHeading[];
  readonly proof: OutlineProof;
  readonly railInsetPx: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isValidOutlineGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export interface OutlineSnapshotValidationOptions {
  /**
   * Geometry is privileged. A same-window `message` source is not trusted:
   * artifact scripts share the iframe's WindowProxy and can forge it. Set this
   * only for a channel established before artifact code can access either port.
   */
  readonly trustedGeometry?: boolean;
}

export const validateOutlineSnapshot = (
  value: unknown,
  options: OutlineSnapshotValidationOptions = {},
): OutlineSnapshot | null => {
  if (
    !isRecord(value) ||
    value.availability !== "complete" ||
    !isValidOutlineGeneration(value.requestGeneration) ||
    !isValidOutlineGeneration(value.generation) ||
    !Array.isArray(value.headings) ||
    value.headings.length < 2 ||
    value.headings.length > ARTIFACT_OUTLINE_POLICY.maxHeadings ||
    !isRecord(value.proof) ||
    typeof value.proof.complete !== "boolean" ||
    typeof value.proof.clearancePx !== "number" ||
    !Number.isFinite(value.proof.clearancePx) ||
    value.proof.clearancePx < 0 ||
    (value.proof.complete && options.trustedGeometry !== true) ||
    typeof value.proof.reason !== "string" ||
    value.proof.reason.length > 128
  ) {
    return null;
  }

  const headings: OutlineHeading[] = [];
  const keys = new Set<string>();
  let aggregateLabelLength = 0;
  for (const candidate of value.headings) {
    if (!isRecord(candidate) || !isValidOutlineKey(candidate.key) || keys.has(candidate.key)) {
      return null;
    }
    if (typeof candidate.label !== "string") return null;
    const parsed = parseOutlineLabel(candidate.label);
    if (!parsed.ok || parsed.label !== candidate.label) return null;
    aggregateLabelLength += parsed.label.length;
    if (aggregateLabelLength > ARTIFACT_OUTLINE_POLICY.maxAggregateLabelCodeUnits) return null;
    keys.add(candidate.key);
    headings.push({ key: candidate.key, label: parsed.label });
  }

  if (value.activeKey !== null && !isValidOutlineKey(value.activeKey)) return null;
  if (value.activeKey !== null && !keys.has(value.activeKey)) return null;
  return {
    activeKey: value.activeKey,
    available: true,
    generation: value.generation,
    headings,
    proof: { clearancePx: value.proof.clearancePx, complete: value.proof.complete },
    railInsetPx: ARTIFACT_OUTLINE_POLICY.railInsetPx,
  };
};
