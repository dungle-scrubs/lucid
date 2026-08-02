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
  readonly type: "snapshot";
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
      readonly type: "active";
      readonly generation: number;
      readonly key: string | null;
    }
  | {
      readonly type: "invalidated";
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

export const reduceOutlinePresentation = (
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
