import {
  ARTIFACT_OUTLINE_POLICY,
  type OutlineLayoutMeasurement,
  type OutlineMotionPreference,
  type OutlineSnapshot,
} from "../shared/artifact-outline.ts";
export type { OutlineLayoutMeasurement } from "../shared/artifact-outline.ts";
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

export interface ChromeArtifactOutline {
  readonly acceptPort: (port: OutlinePort) => boolean;
  readonly activate: (key: string, motion: OutlineMotionPreference) => boolean;
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
    // Geometry changes revoke the old proof before the replacement request
    // crosses the frame. The React control may preserve a focused interaction
    // as transient, but Zustand must never retain a snapshot that still claims
    // pinned geometry while its measured slot is changing.
    clearProjection(true);
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
    if (message.type === "outline-frame-detaching") {
      resetChannel();
      return;
    }
    if (message.type === "outline-revision-complete") {
      if (message.revision !== pendingRevision) return;
      pendingRevision = null;
      requestLayout(true);
      return;
    }
    if (!active || !layoutAvailable || pendingRevision !== null) return;
    // Generation ordering is one ledger (latestProjectionGeneration) with one
    // refusal point: any publication older than the latest accepted one is
    // stale, whatever its type. The snapshot's request-match and the active
    // key's currency are separate concerns, checked in their own branches.
    if (message.generation < latestProjectionGeneration) return;
    if (message.type === "outline-snapshot") {
      if (message.requestGeneration !== requestGeneration) {
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
      // The producer derives its active key from its own projection headings, so
      // a current-generation active key is already a member of this snapshot;
      // the currency match is the only remaining guard.
      if (snapshot === null || message.generation !== snapshot.generation) {
        return;
      }
      options.setState({ outlineSnapshot: { ...snapshot, activeKey: message.key } });
      return;
    }

    // outline-invalidated: the only generation-bearing publication that does
    // not need to match the current snapshot, only to advance the ledger.
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

  const activate = (key: string, motion: OutlineMotionPreference): boolean => {
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
