import {
  ARTIFACT_OUTLINE_POLICY,
  createOutlineRateGate,
  type OutlineSnapshot,
} from "../shared/artifact-outline.ts";
import {
  type OutlineDiagnosticHealth,
  validateOutlinePrivateOutbound,
} from "../shared/protocol.ts";

export type OutlineHealthRecord = OutlineDiagnosticHealth;

export interface OutlineStatePatch {
  readonly outlineHealth?: OutlineHealthRecord | null;
  readonly outlinePending?: boolean;
  readonly outlineSnapshot?: OutlineSnapshot | null;
}

export interface OutlineStateView {
  readonly outlineHealth: OutlineHealthRecord | null;
  readonly outlinePending: boolean;
  readonly outlineSnapshot: OutlineSnapshot | null;
}

export interface OutlinePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

export interface OutlineLayoutMeasurement {
  readonly preferredWidth: number;
  readonly safeInsets: {
    readonly bottom: number;
    readonly right: number;
    readonly top: number;
  };
}

export interface ChromeArtifactOutline {
  readonly acceptPort: (port: OutlinePort) => boolean;
  readonly activate: (key: string, motion: "normal" | "reduced") => boolean;
  readonly dispose: () => void;
  readonly prepareRevision: () => number;
  readonly requestLayout: (force?: boolean) => boolean;
  readonly resetChannel: () => void;
  readonly setActive: (active: boolean) => void;
  readonly setLayoutAvailable: (available: boolean) => void;
}

interface ChromeArtifactOutlineOptions {
  readonly getState: () => OutlineStateView;
  readonly measureLayout: () => OutlineLayoutMeasurement | null;
  readonly now?: () => number;
  readonly setState: (patch: OutlineStatePatch) => void;
}

const layoutKey = (layout: OutlineLayoutMeasurement): string =>
  [
    layout.preferredWidth,
    layout.safeInsets.top,
    layout.safeInsets.right,
    layout.safeInsets.bottom,
  ].join(":");

const normalizeLayout = (layout: OutlineLayoutMeasurement): OutlineLayoutMeasurement => ({
  ...layout,
  preferredWidth: Math.min(ARTIFACT_OUTLINE_POLICY.maxPreferredWidthPx, layout.preferredWidth),
});

export const createChromeArtifactOutline = (
  options: ChromeArtifactOutlineOptions,
): ChromeArtifactOutline => {
  const now = options.now ?? (() => performance.now());
  let rateGate = createOutlineRateGate();
  let active = false;
  let port: OutlinePort | null = null;
  let requestGeneration = 0;
  let latestProjectionGeneration = 0;
  let lastLayoutKey: string | null = null;
  let layoutAvailable = false;
  let nextRevision = 0;
  let pendingRevision: number | null = null;

  const clearProjection = (pending = false): void => {
    const state = options.getState();
    if (
      state.outlineHealth === null &&
      state.outlineSnapshot === null &&
      state.outlinePending === pending
    ) {
      return;
    }
    options.setState({ outlineHealth: null, outlinePending: pending, outlineSnapshot: null });
  };

  const markProjectionPending = (): void => {
    const state = options.getState();
    if (state.outlineHealth === null && state.outlinePending) return;
    // A parent-only safe-slot remeasurement does not replace the iframe DOM,
    // so its current heading identities remain valid while fresh proof is in
    // flight. Retaining them also preserves presentation hysteresis. Revision,
    // frame, session, and overlay invalidation paths still call
    // clearProjection and fail closed immediately.
    options.setState({ outlineHealth: null, outlinePending: true });
  };

  const closePort = (): void => {
    if (port === null) return;
    port.onmessage = null;
    port.close();
    port = null;
  };

  const requestLayout = (force = false): boolean => {
    if (!active || !layoutAvailable || pendingRevision !== null || port === null) return false;
    const measured = options.measureLayout();
    if (measured === null) {
      lastLayoutKey = null;
      clearProjection();
      return false;
    }
    const layout = normalizeLayout(measured);
    const nextLayoutKey = layoutKey(layout);
    if (!force && nextLayoutKey === lastLayoutKey) return false;
    lastLayoutKey = nextLayoutKey;
    requestGeneration += 1;
    rateGate = createOutlineRateGate();
    markProjectionPending();
    port.postMessage({
      ...layout,
      generation: requestGeneration,
      type: "outline-layout-request",
    });
    return true;
  };

  const receive = (data: unknown): void => {
    const message = validateOutlinePrivateOutbound(data);
    if (message === null) return;
    if (message.type === "outline-revision-complete") {
      if (message.revision !== pendingRevision) return;
      pendingRevision = null;
      requestLayout(true);
      return;
    }
    if (!active || !layoutAvailable || pendingRevision !== null) return;
    if (message.type === "outline-snapshot") {
      if (
        message.requestGeneration !== requestGeneration ||
        message.generation < latestProjectionGeneration ||
        !rateGate.accept("snapshot", now())
      ) {
        return;
      }
      latestProjectionGeneration = message.generation;
      options.setState({
        outlineHealth: message.health,
        outlinePending: false,
        outlineSnapshot: message.snapshot,
      });
      return;
    }

    if (message.type === "outline-active") {
      const snapshot = options.getState().outlineSnapshot;
      if (
        snapshot === null ||
        message.generation !== snapshot.generation ||
        (message.key !== null &&
          !snapshot.headings.some((heading) => heading.key === message.key)) ||
        !rateGate.accept("active-key", now())
      ) {
        return;
      }
      options.setState({ outlineSnapshot: { ...snapshot, activeKey: message.key } });
      return;
    }

    if (message.generation < latestProjectionGeneration) return;
    latestProjectionGeneration = message.generation;
    options.setState({
      outlineHealth: message.health,
      outlinePending: true,
      outlineSnapshot: null,
    });
  };

  const acceptPort = (candidate: OutlinePort): boolean => {
    if (port !== null) {
      candidate.close();
      return false;
    }
    // A newly authoritative overlay document cannot complete a barrier armed
    // for a missing or replaced document. Its first private port supersedes
    // that orphan before requesting its own fresh projection.
    pendingRevision = null;
    port = candidate;
    port.onmessage = (event) => receive(event.data);
    port.start();
    requestLayout(true);
    return true;
  };

  const resetChannel = (): void => {
    closePort();
    requestGeneration = 0;
    latestProjectionGeneration = 0;
    lastLayoutKey = null;
    pendingRevision = null;
    rateGate = createOutlineRateGate();
    clearProjection();
  };

  const prepareRevision = (): number => {
    requestGeneration += 1;
    nextRevision += 1;
    pendingRevision = nextRevision;
    lastLayoutKey = null;
    clearProjection();
    return nextRevision;
  };

  const setLayoutAvailable = (available: boolean): void => {
    if (layoutAvailable === available) return;
    layoutAvailable = available;
    lastLayoutKey = null;
    if (layoutAvailable) {
      requestLayout(true);
      return;
    }
    requestGeneration += 1;
    clearProjection();
  };

  const setActive = (next: boolean): void => {
    if (active === next) return;
    active = next;
    if (active) {
      lastLayoutKey = null;
      requestLayout(true);
      return;
    }
    port?.postMessage({ type: "outline-suspend" });
    lastLayoutKey = null;
    clearProjection();
  };

  const activate = (key: string, motion: "normal" | "reduced"): boolean => {
    const state = options.getState();
    const snapshot = state.outlineSnapshot;
    if (
      !active ||
      !layoutAvailable ||
      state.outlinePending ||
      pendingRevision !== null ||
      port === null ||
      snapshot === null ||
      !snapshot.headings.some((heading) => heading.key === key)
    ) {
      return false;
    }
    port.postMessage({
      generation: snapshot.generation,
      key,
      motion,
      type: "outline-activate",
    });
    return true;
  };

  const dispose = (): void => {
    active = false;
    layoutAvailable = false;
    resetChannel();
  };

  return {
    acceptPort,
    activate,
    dispose,
    prepareRevision,
    requestLayout,
    resetChannel,
    setActive,
    setLayoutAvailable,
  };
};
