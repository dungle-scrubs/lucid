/**
 * Shared, DOM-free policy for the artifact outline protocol and presentation.
 *
 * Both iframe and chrome code depend on this module. Keeping the bounds and
 * state transitions here prevents either side from accepting a shape the
 * other side cannot safely produce.
 */

export const ARTIFACT_OUTLINE_POLICY = Object.freeze({
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
  activeReadingThresholdPx: 80,
});

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

const validOutlineKey = (value: unknown): value is string =>
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
    if (!validOutlineKey(key)) return invalidProjection(generation, "invalid-key");
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

export type OutlineActivationResolution =
  | { readonly accepted: true; readonly key: string }
  | { readonly accepted: false; readonly health: OutlineHealth };

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

export interface OutlinePresentationState {
  readonly mode: OutlinePresentationMode;
}

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
  | { readonly type: "invalidate"; readonly focusInside?: boolean }
  | { readonly type: "hover-intent" }
  | { readonly type: "pointer-leave" }
  | { readonly type: "latch" }
  | { readonly type: "activate" }
  | { readonly type: "dismiss" };

export interface OutlinePresentationResult {
  readonly mode: OutlinePresentationMode;
  readonly effects?: readonly ["focus-surface"];
}

const leaveForAbsent = (focusInside: boolean): OutlinePresentationResult =>
  focusInside ? { effects: ["focus-surface"], mode: "ABSENT" } : { mode: "ABSENT" };

export const reduceOutlinePresentation = (
  state: OutlinePresentationState,
  event: OutlinePresentationEvent,
): OutlinePresentationResult => {
  if (event.type === "invalidate") return leaveForAbsent(event.focusInside === true);

  if (event.type === "projection" || event.type === "interaction-finished") {
    if (event.headingCount < 2) return leaveForAbsent(event.focusInside === true);

    if (state.mode === "TRANSIENT_LATCHED" && event.type !== "interaction-finished") {
      return { mode: "TRANSIENT_LATCHED" };
    }

    const threshold =
      state.mode === "PINNED"
        ? ARTIFACT_OUTLINE_POLICY.pinnedRetainClearancePx
        : ARTIFACT_OUTLINE_POLICY.pinnedEnterClearancePx;
    if (event.proof.complete && event.proof.clearancePx >= threshold) {
      return { mode: "PINNED" };
    }
    if (state.mode === "PINNED" && event.focusInside === true) {
      return { mode: "TRANSIENT_LATCHED" };
    }
    return { mode: "TRANSIENT_CLOSED" };
  }

  if (state.mode === "TRANSIENT_CLOSED") {
    if (event.type === "hover-intent") return { mode: "TRANSIENT_HOVER" };
    if (event.type === "latch") return { mode: "TRANSIENT_LATCHED" };
  }
  if (state.mode === "TRANSIENT_HOVER") {
    if (event.type === "latch") return { mode: "TRANSIENT_LATCHED" };
    if (event.type === "pointer-leave" || event.type === "activate") {
      return { mode: "TRANSIENT_CLOSED" };
    }
  }
  if (
    state.mode === "TRANSIENT_LATCHED" &&
    (event.type === "activate" || event.type === "dismiss")
  ) {
    return { mode: "TRANSIENT_CLOSED" };
  }
  return { mode: state.mode };
};

export type OutlineRateChannel = "snapshot" | "active-key";

export interface OutlineRateGate {
  readonly accept: (channel: OutlineRateChannel, nowMs: number) => boolean;
}

export const createOutlineRateGate = (): OutlineRateGate => {
  const accepted: Record<OutlineRateChannel, number[]> = { "active-key": [], snapshot: [] };
  const lastSeen: Record<OutlineRateChannel, number> = {
    "active-key": Number.NEGATIVE_INFINITY,
    snapshot: Number.NEGATIVE_INFINITY,
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

const validGeneration = (value: unknown): value is number =>
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
    value.available !== true ||
    !validGeneration(value.generation) ||
    !Array.isArray(value.headings) ||
    value.headings.length < 2 ||
    value.headings.length > ARTIFACT_OUTLINE_POLICY.maxHeadings ||
    !isRecord(value.proof) ||
    typeof value.proof.complete !== "boolean" ||
    typeof value.proof.clearancePx !== "number" ||
    !Number.isFinite(value.proof.clearancePx) ||
    value.proof.clearancePx < 0 ||
    (value.proof.complete && options.trustedGeometry !== true) ||
    typeof value.railInsetPx !== "number" ||
    !Number.isFinite(value.railInsetPx) ||
    value.railInsetPx < 0 ||
    value.railInsetPx > ARTIFACT_OUTLINE_POLICY.outlineWidthPx
  ) {
    return null;
  }

  const headings: OutlineHeading[] = [];
  const keys = new Set<string>();
  let aggregateLabelLength = 0;
  for (const candidate of value.headings) {
    if (!isRecord(candidate) || !validOutlineKey(candidate.key) || keys.has(candidate.key)) {
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

  if (value.activeKey !== null && !validOutlineKey(value.activeKey)) return null;
  if (value.activeKey !== null && !keys.has(value.activeKey)) return null;
  return {
    activeKey: value.activeKey,
    available: true,
    generation: value.generation,
    headings,
    proof: { clearancePx: value.proof.clearancePx, complete: value.proof.complete },
    railInsetPx: value.railInsetPx,
  };
};
