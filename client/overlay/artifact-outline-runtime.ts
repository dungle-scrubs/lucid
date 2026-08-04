/**
 * Owns the bounded, cancellable artifact-side outline projection and proof.
 * Browser observation and transport adapt into its injected seams; parent UI,
 * persisted state, and artifact focus remain outside. Keeping DOM work here
 * makes complete-or-absent publication and generation identity testable.
 */

import {
  activeOutlineKey,
  ARTIFACT_OUTLINE_POLICY,
  OUTLINE_UNSEEN_TIMESTAMP_MS,
  createOutlineRateGate,
  type OutlineActivation,
  type OutlineHealth,
  type OutlineLayoutRequest,
  type OutlineMotionPreference,
  type OutlineProjection,
  type OutlineRuntimePublication,
  type OutlineSnapshotProof,
  type OutlineSnapshotPublication,
  projectOutlineHeadings,
} from "../shared/artifact-outline.ts";
import { revealOutlineActivation, type RevealEnvironment } from "./reveal.ts";

export interface OutlineRuntimeRect {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface OutlineRuntimeStyle {
  readonly boxShadow: string;
  readonly clipPath: string;
  readonly display: string;
  readonly filter: string;
  readonly opacity: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly position: string;
  readonly textShadow: string;
  readonly transform: string;
  readonly visibility: string;
}

export interface OutlineRuntimeElement {
  readonly activeMotion: boolean;
  readonly ariaHidden: boolean;
  readonly clientHeight: number;
  readonly clientWidth: number;
  readonly connected: boolean;
  readonly hasBox: boolean;
  readonly hidden: boolean;
  readonly inert: boolean;
  readonly lightDom: boolean;
  /** Present only in the browser adapter, for the shared reveal seam. */
  readonly nativeElement?: Element;
  readonly rect: OutlineRuntimeRect;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly style: OutlineRuntimeStyle;
  readonly tagName: string;
  readonly text: string;
  readonly textComplete: boolean;
  readonly textNodesExamined: number;
  readonly owned?: boolean;
  readonly rootScroller?: boolean;
}

export interface ArtifactOutlineGeometry<ElementType extends OutlineRuntimeElement> {
  readonly allElements: () => readonly ElementType[];
  readonly completeTraversal: (deadlineMs: number) => boolean;
  readonly headingCandidates: () => readonly ElementType[];
  readonly isSettled: () => boolean;
  readonly parentElement: (element: ElementType) => ElementType | null;
  readonly pseudoContent: (element: ElementType) => {
    readonly after: string;
    readonly before: string;
  };
  readonly rect: (element: ElementType) => OutlineRuntimeRect;
  /** The two trust seams are required like every other member here. Optional,
   *  an absent one read as TRUSTED, so a bootstrap that renamed or dropped one
   *  lost the guard and said nothing. */
  readonly proofRealmTrusted: () => boolean;
  readonly styleRealmTrusted: () => boolean;
  readonly viewport: () => {
    readonly clientWidth: number;
    readonly height: number;
    readonly width: number;
  };
}

export interface ArtifactOutlineDebugInfo {
  readonly connected: boolean;
  readonly dormant: boolean;
  readonly generation: number;
  readonly headingCount: number;
  readonly healthOccurrenceCount: number;
  readonly inspected: number;
  readonly examinedTextCodeUnits: number;
  readonly examinedTextNodes: number;
  readonly lastDurationMs: number;
  readonly pendingFrame: boolean;
  readonly pendingQuietTask: boolean;
  readonly proofClearancePx: number;
  readonly proofComplete: boolean;
  readonly proofReason: string;
  readonly healthCode: OutlineHealth["code"] | null;
  readonly taskCount: number;
}

interface RuntimeDependencies<ElementType extends OutlineRuntimeElement> {
  /** Collections built from intrinsics captured before the artifact ran. There
   *  is no fallback to a raw `new Map()`: those are the poisonable ones the
   *  pre-artifact bootstrap exists to avoid. */
  readonly createMap: <Key, Value>() => OutlineRuntimeMap<Key, Value>;
  readonly createWeakMap: <Key extends object, Value>() => OutlineRuntimeWeakMap<Key, Value>;
  readonly geometry: ArtifactOutlineGeometry<ElementType>;
  readonly now: () => number;
  /** The one optional seam: a notification that the proof realm was rejected,
   *  not a safety input the runtime reads a verdict from. */
  readonly onProofRealmRejected?: () => void;
  readonly publish: (publication: OutlineRuntimePublication) => void;
  readonly scheduleFrame: (task: () => void) => () => void;
  readonly scheduleQuiet: (delayMs: number, task: () => void) => () => void;
}

export interface OutlineRuntimeMap<Key, Value> {
  readonly clear: () => void;
  readonly get: (key: Key) => Value | undefined;
  readonly set: (key: Key, value: Value) => void;
}

export interface OutlineRuntimeWeakMap<Key extends object, Value> {
  readonly get: (key: Key) => Value | undefined;
  readonly set: (key: Key, value: Value) => void;
}

interface WorkState {
  examinedTextCodeUnits: number;
  examinedTextNodes: number;
  inspected: number;
  readonly startedAt: number;
}

const SNAPSHOT_MINIMUM_INTERVAL_MS = 1_000 / ARTIFACT_OUTLINE_POLICY.maxSnapshotsPerSecond;

const visible = (style: OutlineRuntimeStyle): boolean =>
  style.display !== "none" &&
  style.visibility !== "hidden" &&
  style.visibility !== "collapse" &&
  style.opacity !== "0";

const scrollable = (overflow: string): boolean =>
  overflow === "auto" || overflow === "scroll" || overflow === "overlay";

const realPseudoContent = (content: string): boolean => {
  if (content.length > 16) return true;
  const normalized = content.replaceAll('"', "").trim();
  return normalized !== "" && normalized !== "none" && normalized !== "normal";
};

const intersects = (rect: OutlineRuntimeRect, candidate: OutlineRuntimeRect): boolean =>
  rect.right > candidate.left &&
  rect.left < candidate.right &&
  rect.bottom > candidate.top &&
  rect.top < candidate.bottom;

const rectangleClearance = (rect: OutlineRuntimeRect, candidate: OutlineRuntimeRect): number => {
  if (intersects(rect, candidate)) return 0;
  const horizontal = Math.max(candidate.left - rect.right, rect.left - candidate.right, 0);
  const vertical = Math.max(candidate.top - rect.bottom, rect.top - candidate.bottom, 0);
  if (horizontal === 0) return vertical;
  if (vertical === 0) return horizontal;
  return Math.min(horizontal, vertical);
};

const health = (
  code: OutlineHealth["code"],
  generation: number,
  reason: string,
): OutlineHealth => ({
  code,
  generation,
  occurrenceCount: 1,
  reason,
});

export class ArtifactOutlineRuntime<ElementType extends OutlineRuntimeElement> {
  readonly #dependencies: RuntimeDependencies<ElementType>;
  #activeKey: string | null = null;
  #cancelActiveSample: (() => void) | null = null;
  #cancelFrame: (() => void) | null = null;
  #cancelQuiet: (() => void) | null = null;
  #connected = true;
  #elementsByKey: OutlineRuntimeMap<string, ElementType>;
  #elementKeys: OutlineRuntimeWeakMap<object, string>;
  #generation = 0;
  #health: OutlineHealth | null = null;
  #examinedTextCodeUnits = 0;
  #examinedTextNodes = 0;
  #inspected = 0;
  #lastDurationMs = 0;
  #lastProjectionStartedAt = OUTLINE_UNSEEN_TIMESTAMP_MS;
  #lastSnapshotAt = OUTLINE_UNSEEN_TIMESTAMP_MS;
  #lastActiveSampleAt = OUTLINE_UNSEEN_TIMESTAMP_MS;
  #cancelSnapshot: (() => void) | null = null;
  #pendingSnapshot: OutlineSnapshotPublication | null = null;
  #projection: OutlineProjection = { generation: 0, kind: "absent" };
  #proofDiagnostic: OutlineSnapshotProof = {
    clearancePx: 0,
    complete: false,
    reason: "not-requested",
  };
  #request: OutlineLayoutRequest | null = null;
  readonly #rateGate = createOutlineRateGate();
  #keyEpoch = 0;
  #nextElementKey = 0;
  #scheduleVersion = 0;
  #taskCount = 0;
  #budgetRetriesRemaining = 0;

  constructor(dependencies: RuntimeDependencies<ElementType>) {
    this.#dependencies = dependencies;
    this.#elementsByKey = dependencies.createMap<string, ElementType>();
    this.#elementKeys = dependencies.createWeakMap<object, string>();
  }

  requestLayout(request: OutlineLayoutRequest): void {
    if (!this.#connected) return;
    const initialRequest = this.#request === null;
    this.#withdrawProjection("layout-request");
    this.#clearPendingSnapshot();
    this.#request = request;
    this.invalidate(initialRequest ? "initial-layout-request" : "layout-request", false);
  }

  invalidate(reason: string, publishInvalidation = true, replenishBudgetRetry = true): void {
    if (!this.#connected || this.#request === null) return;
    if (this.#rejectIfProofRealmUntrusted()) return;
    if (replenishBudgetRetry) this.#budgetRetriesRemaining = 1;
    this.#scheduleVersion += 1;
    const version = this.#scheduleVersion;
    this.#cancelQuiet?.();
    this.#cancelQuiet = null;
    if (publishInvalidation) this.#withdrawProjection(reason);
    const throttleCompute = reason !== "initial-layout-request" && reason !== "revision";
    const schedule = (delayMs: number): void => {
      this.#cancelQuiet = this.#dependencies.scheduleQuiet(delayMs, () => {
        this.#cancelQuiet = null;
        if (this.#rejectIfProofRealmUntrusted()) return;
        if (!this.#connected || version !== this.#scheduleVersion) return;
        if (throttleCompute) {
          const remaining =
            SNAPSHOT_MINIMUM_INTERVAL_MS -
            (this.#dependencies.now() - this.#lastProjectionStartedAt);
          if (remaining > 0) {
            schedule(Math.ceil(remaining));
            return;
          }
        }
        this.#runProjection();
      });
    };
    schedule(ARTIFACT_OUTLINE_POLICY.quietLayoutMs);
  }

  invalidateWithHealth(record: OutlineHealth): void {
    if (!this.#connected) return;
    if (this.#projection.kind === "complete") {
      this.#withdrawProjection(record.reason ?? "activation-invalidated", record);
    } else {
      this.#health = record;
      this.#dependencies.publish({
        generation: record.generation,
        health: record,
        type: "outline-invalidated",
      });
    }
    this.invalidate(record.reason ?? "activation-invalidated", false);
  }

  rejectUntrustedProofRealm(): void {
    if (!this.#connected) return;
    this.#rejectUntrustedProofRealm();
  }

  revise(): void {
    if (!this.#connected) return;
    this.#withdrawProjection("revision");
    this.#clearPendingSnapshot();
    this.#generation += 1;
    this.#keyEpoch += 1;
    this.#nextElementKey = 0;
    this.#elementKeys = this.#dependencies.createWeakMap<object, string>();
    this.#projection = { generation: this.#generation, kind: "absent" };
    this.#elementsByKey.clear();
    this.invalidate("revision");
  }

  suspend(): void {
    if (!this.#connected) return;
    this.#scheduleVersion += 1;
    this.#cancelQuiet?.();
    this.#cancelQuiet = null;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#cancelActiveSample?.();
    this.#cancelActiveSample = null;
    this.#clearPendingSnapshot();
    this.#request = null;
    this.#elementsByKey.clear();
    this.#projection = { generation: this.#generation, kind: "absent" };
    this.#activeKey = null;
    this.#proofDiagnostic = { clearancePx: 0, complete: false, reason: "suspended" };
  }

  #withdrawProjection(reason: string, healthOverride?: OutlineHealth): void {
    if (this.#projection.kind !== "complete") return;
    this.#cancelActiveSample?.();
    this.#cancelActiveSample = null;
    this.#clearPendingSnapshot();
    this.#health = healthOverride ?? health("AO-005", this.#generation, reason);
    this.#dependencies.publish({
      generation: this.#generation,
      health: this.#health,
      type: "outline-invalidated",
    });
    this.#projection = { generation: this.#generation, kind: "absent" };
    this.#elementsByKey.clear();
    this.#activeKey = null;
    this.#proofDiagnostic = { clearancePx: 0, complete: false, reason };
  }

  #rejectUntrustedProofRealm(): void {
    this.#scheduleVersion += 1;
    this.#cancelQuiet?.();
    this.#cancelQuiet = null;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#cancelActiveSample?.();
    this.#cancelActiveSample = null;
    this.#clearPendingSnapshot();
    this.#withdrawProjection("untrusted-proof-realm");
    this.#proofDiagnostic = {
      clearancePx: 0,
      complete: false,
      reason: "untrusted-proof-realm",
    };
    this.#dependencies.onProofRealmRejected?.();
  }

  #rejectIfProofRealmUntrusted(): boolean {
    if (this.#dependencies.geometry.proofRealmTrusted()) return false;
    this.#rejectUntrustedProofRealm();
    return true;
  }

  activate(
    activation: OutlineActivation,
    motion: OutlineMotionPreference,
    environment: RevealEnvironment,
  ): boolean {
    return revealOutlineActivation(
      this.#projection,
      activation,
      (key) => this.#elementsByKey.get(key)?.nativeElement ?? null,
      motion,
      environment,
    );
  }

  trackActive(): void {
    if (this.#rejectIfProofRealmUntrusted()) return;
    if (!this.#connected || this.#request === null || this.#projection.kind !== "complete") return;
    if (this.#cancelFrame !== null || this.#cancelActiveSample !== null) return;
    this.#cancelFrame = this.#dependencies.scheduleFrame(() => {
      this.#cancelFrame = null;
      if (this.#rejectIfProofRealmUntrusted()) return;
      if (!this.#connected || this.#projection.kind !== "complete") return;
      const now = this.#dependencies.now();
      const minimumIntervalMs = 1_000 / ARTIFACT_OUTLINE_POLICY.maxActiveKeysPerSecond;
      const elapsed = now - this.#lastActiveSampleAt;
      if (elapsed < minimumIntervalMs) {
        if (this.#cancelActiveSample === null) {
          this.#cancelActiveSample = this.#dependencies.scheduleQuiet(
            Math.ceil(minimumIntervalMs - elapsed),
            () => {
              this.#cancelActiveSample = null;
              this.trackActive();
            },
          );
        }
        return;
      }
      this.#lastActiveSampleAt = now;
      const positions = this.#projection.headings.flatMap((heading) => {
        const element = this.#elementsByKey.get(heading.key);
        const rect = element ? this.#dependencies.geometry.rect(element) : null;
        return element?.connected && rect ? [{ key: heading.key, top: rect.top }] : [];
      });
      const next = activeOutlineKey(positions);
      if (next === this.#activeKey) return;
      if (!this.#rateGate.accept("active-key", now)) return;
      this.#activeKey = next;
      this.#dependencies.publish({
        generation: this.#generation,
        key: next,
        type: "outline-active",
      });
    });
  }

  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#scheduleVersion += 1;
    this.#cancelQuiet?.();
    this.#cancelQuiet = null;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#cancelActiveSample?.();
    this.#cancelActiveSample = null;
    this.#clearPendingSnapshot();
    this.#elementsByKey.clear();
    this.#projection = { generation: this.#generation, kind: "absent" };
    this.#activeKey = null;
    this.#proofDiagnostic = { clearancePx: 0, complete: false, reason: "disconnected" };
  }

  debugInfo(): ArtifactOutlineDebugInfo {
    return {
      connected: this.#connected,
      dormant: this.#request === null,
      generation: this.#generation,
      headingCount: this.#projection.kind === "complete" ? this.#projection.headings.length : 0,
      healthOccurrenceCount: this.#health?.occurrenceCount ?? 0,
      healthCode: this.#health?.code ?? null,
      inspected: this.#inspected,
      examinedTextCodeUnits: this.#examinedTextCodeUnits,
      examinedTextNodes: this.#examinedTextNodes,
      lastDurationMs: this.#lastDurationMs,
      pendingFrame: this.#cancelFrame !== null,
      pendingQuietTask: this.#cancelQuiet !== null,
      proofClearancePx: this.#proofDiagnostic.clearancePx,
      proofComplete: this.#proofDiagnostic.complete,
      proofReason: this.#proofDiagnostic.reason,
      taskCount: this.#taskCount,
    };
  }

  #consume(work: WorkState): boolean {
    work.inspected += 1;
    return work.inspected <= ARTIFACT_OUTLINE_POLICY.proofElementLimit && this.#withinTime(work);
  }

  #withinTime(work: WorkState): boolean {
    return this.#dependencies.now() - work.startedAt <= ARTIFACT_OUTLINE_POLICY.proofTimeBudgetMs;
  }

  #keyFor(element: ElementType): string {
    const identity = element.nativeElement ?? element;
    const existing = this.#elementKeys.get(identity);
    if (existing !== undefined) return existing;
    this.#nextElementKey += 1;
    const key = `ao-${this.#keyEpoch}-${this.#nextElementKey}`;
    this.#elementKeys.set(identity, key);
    return key;
  }

  #clearPendingSnapshot(): void {
    this.#cancelSnapshot?.();
    this.#cancelSnapshot = null;
    this.#pendingSnapshot = null;
  }

  #scheduleBudgetRetry(): void {
    if (this.#budgetRetriesRemaining === 0) return;
    this.#budgetRetriesRemaining -= 1;
    this.invalidate("budget-retry", false, false);
  }

  #publishSnapshot(publication: OutlineSnapshotPublication): void {
    this.#pendingSnapshot = publication;
    const now = this.#dependencies.now();
    const elapsed = now - this.#lastSnapshotAt;
    if (Number.isFinite(elapsed) && elapsed < SNAPSHOT_MINIMUM_INTERVAL_MS) {
      if (this.#cancelSnapshot === null) {
        this.#cancelSnapshot = this.#dependencies.scheduleQuiet(
          Math.ceil(SNAPSHOT_MINIMUM_INTERVAL_MS - elapsed),
          () => {
            this.#cancelSnapshot = null;
            if (this.#rejectIfProofRealmUntrusted()) return;
            const pending = this.#pendingSnapshot;
            if (pending !== null && this.#connected) this.#publishSnapshot(pending);
          },
        );
      }
      return;
    }
    if (!this.#rateGate.accept("snapshot", now)) {
      if (this.#cancelSnapshot === null) {
        this.#cancelSnapshot = this.#dependencies.scheduleQuiet(
          SNAPSHOT_MINIMUM_INTERVAL_MS,
          () => {
            this.#cancelSnapshot = null;
            if (this.#rejectIfProofRealmUntrusted()) return;
            const pending = this.#pendingSnapshot;
            if (pending !== null && this.#connected) this.#publishSnapshot(pending);
          },
        );
      }
      return;
    }
    this.#pendingSnapshot = null;
    this.#lastSnapshotAt = now;
    this.#dependencies.publish(publication);
  }

  #eligible(element: ElementType, work: WorkState): boolean | "budget" {
    if (element.tagName !== "H2") return false;
    if (!this.#consume(work)) return "budget";
    const textComplete = element.textComplete;
    work.examinedTextCodeUnits += element.text.length;
    work.examinedTextNodes += element.textNodesExamined;
    const elementExcluded =
      !element.connected || !element.lightDom || !element.hasBox || element.text.trim() === "";
    if (!this.#withinTime(work)) return "budget";
    if (!textComplete) return "budget";
    if (elementExcluded) return false;
    let current: ElementType | null = element;
    while (current !== null) {
      if (!this.#consume(work)) return "budget";
      const excluded =
        current.hidden || current.inert || current.ariaHidden || !visible(current.style);
      const nestedScroller =
        current !== element &&
        !current.rootScroller &&
        scrollable(current.style.overflowY) &&
        current.scrollHeight > current.clientHeight + 1;
      if (!this.#withinTime(work)) return "budget";
      if (excluded || nestedScroller) return false;
      current = this.#dependencies.geometry.parentElement(current);
    }
    return true;
  }

  #proof(
    request: OutlineLayoutRequest,
    work: WorkState,
  ): {
    readonly complete: boolean;
    readonly clearancePx: number;
    readonly reason: string;
  } {
    if (!this.#consume(work)) {
      return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
    }
    if (!this.#dependencies.geometry.styleRealmTrusted()) {
      return { clearancePx: 0, complete: false, reason: "untrusted-style-realm" };
    }
    const settled = this.#dependencies.geometry.isSettled();
    if (!this.#withinTime(work)) {
      return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
    }
    if (!settled) {
      return { clearancePx: 0, complete: false, reason: "layout-unsettled" };
    }
    const viewport = this.#dependencies.geometry.viewport();
    if (!this.#withinTime(work)) {
      return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
    }
    const rightInset = Math.max(request.safeInsets.right, viewport.width - viewport.clientWidth);
    const candidate = {
      bottom: viewport.height - request.safeInsets.bottom,
      left: viewport.width - rightInset - request.preferredWidth,
      right: viewport.width - rightInset,
      top: request.safeInsets.top,
    };
    if (
      candidate.left < 0 ||
      candidate.right > viewport.clientWidth ||
      candidate.bottom <= candidate.top
    ) {
      return { clearancePx: 0, complete: false, reason: "candidate-outside-safe-viewport" };
    }
    let minimumClearance = Math.min(
      candidate.left,
      viewport.clientWidth - candidate.right,
      candidate.top,
      viewport.height - candidate.bottom,
    );

    for (const element of this.#dependencies.geometry.allElements()) {
      if (!this.#consume(work)) {
        return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
      }
      if (element.owned) continue;
      const style = element.style;
      const hasBox = element.hasBox;
      if (!this.#withinTime(work)) {
        return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
      }
      if (!visible(style) || !hasBox) continue;
      if (
        !element.rootScroller &&
        scrollable(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 1
      ) {
        return { clearancePx: 0, complete: false, reason: "nested-vertical-scroller" };
      }
      const { before, after } = this.#dependencies.geometry.pseudoContent(element);
      const rect = element.rect;
      const visibleHorizontalOverflow =
        style.overflowX === "visible" && element.scrollWidth > element.clientWidth + 1;
      if (!this.#withinTime(work)) {
        return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
      }
      if (realPseudoContent(before) || realPseudoContent(after)) {
        return { clearancePx: 0, complete: false, reason: "pseudo-content-near-candidate" };
      }
      if (
        style.boxShadow !== "none" ||
        style.filter !== "none" ||
        style.textShadow !== "none" ||
        (style.outlineStyle !== "none" && style.outlineWidth !== "0px")
      ) {
        return { clearancePx: 0, complete: false, reason: "unbounded-shadow-near-candidate" };
      }
      if (style.clipPath !== "none") {
        return { clearancePx: 0, complete: false, reason: "clipped-paint-near-candidate" };
      }
      if (visibleHorizontalOverflow) {
        return { clearancePx: 0, complete: false, reason: "visible-horizontal-overflow" };
      }
      if (element.activeMotion) {
        return { clearancePx: 0, complete: false, reason: "dynamic-paint" };
      }
      if (intersects(rect, candidate)) {
        return { clearancePx: 0, complete: false, reason: "box-intersection" };
      }
      minimumClearance = Math.min(minimumClearance, rectangleClearance(rect, candidate));
    }
    if (!this.#withinTime(work)) {
      return { clearancePx: 0, complete: false, reason: "work-budget-exhausted" };
    }
    return {
      clearancePx: Math.max(0, minimumClearance),
      complete: true,
      reason: "complete-unused-rectangle",
    };
  }

  #runProjection(): void {
    const request = this.#request;
    if (request === null) return;
    if (this.#rejectIfProofRealmUntrusted()) return;
    this.#lastProjectionStartedAt = this.#dependencies.now();
    this.#taskCount += 1;
    this.#generation += 1;
    const work: WorkState = {
      examinedTextCodeUnits: 0,
      examinedTextNodes: 0,
      inspected: 0,
      startedAt: this.#dependencies.now(),
    };
    const deadlineMs = work.startedAt + ARTIFACT_OUTLINE_POLICY.proofTimeBudgetMs;
    if (!this.#dependencies.geometry.completeTraversal(deadlineMs)) {
      this.#deferBudget(request, work, "item-budget-exhausted");
      return;
    }
    const eligible: ElementType[] = [];
    for (const candidate of this.#dependencies.geometry.headingCandidates()) {
      const verdict = this.#eligible(candidate, work);
      if (verdict === "budget") {
        this.#deferBudget(request, work, "work-budget-exhausted");
        return;
      }
      if (!verdict) continue;
      eligible.push(candidate);
      if (eligible.length > ARTIFACT_OUTLINE_POLICY.maxHeadings) {
        this.#publishUnavailable(
          request,
          work,
          "heading-count",
          health("AO-001", this.#generation, "heading-count"),
        );
        return;
      }
      if (work.examinedTextCodeUnits > ARTIFACT_OUTLINE_POLICY.maxAggregateExaminedLabelCodeUnits) {
        this.#publishUnavailable(
          request,
          work,
          "aggregate-label-length",
          health("AO-001", this.#generation, "aggregate-label-length"),
        );
        return;
      }
    }

    const keyed = eligible.map((element) => ({
      element,
      input: { key: this.#keyFor(element), text: element.text },
    }));
    const projection = projectOutlineHeadings(
      this.#generation,
      keyed.map(({ input }) => input),
    );
    if (projection.kind === "invalid") {
      this.#publishUnavailable(
        request,
        work,
        projection.health.reason ?? "projection-invalid",
        projection.health,
      );
      return;
    }
    this.#projection = projection;
    this.#elementsByKey.clear();
    if (projection.kind === "complete") {
      for (const { element, input } of keyed) this.#elementsByKey.set(input.key, element);
    }
    const proof =
      projection.kind === "complete"
        ? this.#proof(request, work)
        : {
            clearancePx: 0,
            complete: false,
            reason: "fewer-than-two-headings",
          };
    if (!proof.complete && proof.reason === "layout-unsettled") {
      this.#publishUnavailable(
        request,
        work,
        proof.reason,
        health("AO-003", this.#generation, proof.reason),
      );
      return;
    }
    this.#activeKey =
      projection.kind === "complete"
        ? activeOutlineKey(
            projection.headings.flatMap((heading) => {
              const element = this.#elementsByKey.get(heading.key);
              return element ? [{ key: heading.key, top: element.rect.top }] : [];
            }),
          )
        : null;
    this.#health =
      projection.kind !== "complete" || proof.complete
        ? null
        : health(
            proof.reason === "work-budget-exhausted" ? "AO-004" : "AO-003",
            this.#generation,
            proof.reason,
          );
    this.#inspected = work.inspected;
    this.#examinedTextCodeUnits = work.examinedTextCodeUnits;
    this.#examinedTextNodes = work.examinedTextNodes;
    this.#lastDurationMs = this.#dependencies.now() - work.startedAt;
    this.#proofDiagnostic = proof;
    this.#publishSnapshot({
      activeKey: this.#activeKey,
      availability: projection.kind === "complete" ? "complete" : "absent",
      generation: this.#generation,
      headings: projection.kind === "complete" ? projection.headings : [],
      ...(this.#health ? { health: this.#health } : {}),
      proof,
      requestGeneration: request.generation,
      type: "outline-snapshot",
    });
    if (!proof.complete && proof.reason === "work-budget-exhausted") {
      this.#scheduleBudgetRetry();
    }
  }

  /**
   * A budget miss when a projection ALREADY exists is a stale proof, not a
   * vanished outline.
   *
   * The traversal runs under an 8ms deadline, and the frames where it is most
   * likely to be missed are exactly the busy ones - scrolling a long artifact.
   * Publishing "absent" there unmounts the rail and mounts it again a beat
   * later, so the outline blinks in and out of the page for the whole scroll
   * (measured: nine transitions in four seconds, the rail at an identical
   * position each time it returned - it was never moving, only disappearing).
   *
   * The headings from the last complete traversal are still the headings; only
   * the geometry proof is unknown. So they are republished as they were, with
   * the proof marked incomplete - which keeps the outline transient rather than
   * pinned, and schedules the retry that will settle it. Structural
   * invalidation (a revision, a disconnected heading, a new layout request)
   * still tears the projection down through its own paths; this is only for
   * running out of time.
   *
   * With no projection to retain there is nothing to keep, and this falls back
   * to publishing absent.
   */
  #deferBudget(request: OutlineLayoutRequest, work: WorkState, reason: string): void {
    const projection = this.#projection;
    if (projection.kind !== "complete") {
      this.#publishUnavailable(request, work, reason);
      return;
    }
    // Carry the retained projection onto the CURRENT generation: the chrome
    // echoes a snapshot's generation back on activation, and a projection left
    // on the old one would answer every jump with `stale-generation`.
    this.#projection = { ...projection, generation: this.#generation };
    const proof = { clearancePx: 0, complete: false, reason };
    this.#health = health("AO-004", this.#generation, reason);
    this.#inspected = work.inspected;
    this.#examinedTextCodeUnits = work.examinedTextCodeUnits;
    this.#examinedTextNodes = work.examinedTextNodes;
    this.#lastDurationMs = this.#dependencies.now() - work.startedAt;
    this.#proofDiagnostic = proof;
    this.#publishSnapshot({
      activeKey: this.#activeKey,
      availability: "complete",
      generation: this.#generation,
      headings: projection.headings,
      health: this.#health,
      proof,
      requestGeneration: request.generation,
      type: "outline-snapshot",
    });
    this.#scheduleBudgetRetry();
  }

  /**
   * Recompute for a change that leaves the headings intact.
   *
   * Withdrawing on scroll failed closed, which sounds right and is not: the
   * placement proof is what guards the pinned panel, and it is RECOMPUTED here
   * either way. Publishing the withdrawal as well took the whole outline down
   * for the length of every scroll and brought it back a second later
   * (measured on a real artifact: nine appearances and disappearances across
   * four seconds, the rail at an identical position each time it returned - it
   * was never moving, only vanishing).
   *
   * So the projection stays up while the recompute runs. If the clearance no
   * longer holds, that recompute publishes an incomplete proof and the reducer
   * steps the panel back to the rail, exactly as before - the guard is the
   * proof, not the teardown.
   */
  invalidateGeometry(reason: string): void {
    this.invalidate(reason, false);
  }

  #publishUnavailable(
    request: OutlineLayoutRequest,
    work: WorkState,
    reason: string,
    record = health("AO-004", this.#generation, reason),
  ): void {
    this.#projection = { generation: this.#generation, kind: "absent" };
    this.#elementsByKey.clear();
    this.#activeKey = null;
    this.#health = record;
    this.#inspected = work.inspected;
    this.#examinedTextCodeUnits = work.examinedTextCodeUnits;
    this.#examinedTextNodes = work.examinedTextNodes;
    this.#lastDurationMs = this.#dependencies.now() - work.startedAt;
    this.#proofDiagnostic = { clearancePx: 0, complete: false, reason };
    this.#publishSnapshot({
      activeKey: null,
      availability: "absent",
      generation: this.#generation,
      headings: [],
      health: record,
      proof: { clearancePx: 0, complete: false, reason },
      requestGeneration: request.generation,
      type: "outline-snapshot",
    });
    if (record.code === "AO-004") this.#scheduleBudgetRetry();
  }
}
