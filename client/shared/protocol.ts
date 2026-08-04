import type { Anchor } from "../../src/anchors/anchor.ts";
import type { PayloadAnnotation } from "../../src/protocol/wire.ts";
import {
  ARTIFACT_OUTLINE_POLICY,
  isValidOutlineGeneration,
  isValidOutlineKey,
  type OutlineActivation,
  type OutlineHealthCode,
  type OutlineLayoutRequest,
  type OutlineMotionPreference,
  type OutlineRuntimePublication,
  type OutlineSnapshot,
  validateOutlineSnapshot,
} from "./artifact-outline.ts";

/**
 * postMessage protocol between the chrome (parent document) and the overlay
 * (injected into the artifact iframe). The chrome owns all server I/O; the
 * overlay owns DOM targeting and highlight rendering on the surface.
 */

/** The annotation as the wire delivers it (src/protocol/wire.ts) - the chrome
 *  forwards it to the overlay unchanged, so the highlight message carries the
 *  same shape the server built. */
export type PayloadAnnotationLike = PayloadAnnotation;

/**
 * A composed-but-unsent annotation's anchor. The chrome sends these so the
 * overlay can paint the queued item in place (its "queued" lifecycle state),
 * keeping the left-panel card and its spot in the artifact visibly linked.
 */
export interface QueuedAnchorLike {
  readonly id: string;
  readonly target: Anchor;
  /** Every spot a cmd-collected item covers; `target` is always the first.
   *  Absent on a single-target item (and from older chromes). */
  readonly targets?: readonly Anchor[];
}

/** The first message an injected document sends, synchronously before any
 * artifact-authored script. The transferred port is the authority; this
 * forgeable envelope carries no geometry or outline state of its own. */
export interface OutlineChannelBootstrap {
  readonly source: "lucid-overlay-bootstrap";
  readonly type: "private-channel";
  readonly version: 1;
}

export const isOutlineChannelBootstrap = (value: unknown): value is OutlineChannelBootstrap =>
  isRecord(value) &&
  value.source === "lucid-overlay-bootstrap" &&
  value.type === "private-channel" &&
  value.version === 1;

export type OutlinePrivateInbound =
  | (OutlineLayoutRequest & { readonly type: "outline-layout-request" })
  | { readonly type: "outline-suspend" }
  | (OutlineActivation & {
      readonly type: "outline-activate";
      readonly motion: OutlineMotionPreference;
    });

export type OutlinePrivateOutbound =
  | OutlineRuntimePublication
  | { readonly type: "outline-frame-detaching" }
  | { readonly type: "outline-revision-complete"; readonly revision: number };

export interface OutlineDiagnosticHealth {
  readonly code: OutlineHealthCode;
  readonly count: number;
  readonly generation: number;
}

export type ValidatedOutlinePrivateOutbound =
  | {
      readonly type: "outline-snapshot";
      readonly requestGeneration: number;
      readonly generation: number;
      readonly snapshot: OutlineSnapshot | null;
      readonly health: OutlineDiagnosticHealth | null;
    }
  | {
      readonly type: "outline-active";
      readonly generation: number;
      readonly key: string | null;
    }
  | {
      readonly type: "outline-invalidated";
      readonly generation: number;
      readonly health: OutlineDiagnosticHealth;
    }
  | {
      readonly type: "outline-revision-complete";
      readonly revision: number;
    }
  | { readonly type: "outline-frame-detaching" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const validateOutlinePrivateInbound = (data: unknown): OutlinePrivateInbound | null => {
  if (!isRecord(data)) return null;
  if (data.type === "outline-suspend") return { type: "outline-suspend" };
  if (!isValidOutlineGeneration(data.generation)) return null;
  if (data.type === "outline-layout-request") {
    if (
      !finiteNonNegative(data.preferredWidth) ||
      data.preferredWidth > ARTIFACT_OUTLINE_POLICY.maxPreferredWidthPx ||
      !isRecord(data.safeInsets) ||
      !finiteNonNegative(data.safeInsets.top) ||
      !finiteNonNegative(data.safeInsets.right) ||
      !finiteNonNegative(data.safeInsets.bottom)
    ) {
      return null;
    }
    return {
      generation: data.generation,
      preferredWidth: data.preferredWidth,
      safeInsets: {
        bottom: data.safeInsets.bottom,
        right: data.safeInsets.right,
        top: data.safeInsets.top,
      },
      type: "outline-layout-request",
    };
  }
  if (
    data.type !== "outline-activate" ||
    !isValidOutlineKey(data.key) ||
    (data.motion !== "normal" && data.motion !== "reduced")
  ) {
    return null;
  }
  return {
    generation: data.generation,
    key: data.key,
    motion: data.motion,
    type: "outline-activate",
  };
};

const OUTLINE_HEALTH_CODES = new Set<OutlineHealthCode>([
  "AO-001",
  "AO-002",
  "AO-003",
  "AO-004",
  "AO-005",
]);

const validateOutlineHealth = (value: unknown): OutlineDiagnosticHealth | null => {
  if (!isRecord(value) || !OUTLINE_HEALTH_CODES.has(value.code as OutlineHealthCode)) return null;
  if (
    !isValidOutlineGeneration(value.generation) ||
    !Number.isSafeInteger(value.occurrenceCount) ||
    (value.occurrenceCount as number) < 1 ||
    (value.occurrenceCount as number) > 1_000_000 ||
    (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 128))
  ) {
    return null;
  }
  return {
    code: value.code as OutlineHealthCode,
    count: value.occurrenceCount as number,
    generation: value.generation,
  };
};

export const validateOutlinePrivateOutbound = (
  data: unknown,
): ValidatedOutlinePrivateOutbound | null => {
  if (!isRecord(data)) return null;
  if (data.type === "outline-frame-detaching") return { type: "outline-frame-detaching" };
  if (data.type === "outline-revision-complete") {
    return isValidOutlineGeneration(data.revision)
      ? { revision: data.revision, type: "outline-revision-complete" }
      : null;
  }
  if (!isValidOutlineGeneration(data.generation)) return null;
  if (data.type === "outline-active") {
    if (data.key !== null && !isValidOutlineKey(data.key)) return null;
    return { generation: data.generation, key: data.key, type: "outline-active" };
  }
  if (data.type === "outline-invalidated") {
    const health = validateOutlineHealth(data.health);
    if (health === null || health.generation !== data.generation) return null;
    return { generation: data.generation, health, type: "outline-invalidated" };
  }
  if (data.type !== "outline-snapshot" || !isValidOutlineGeneration(data.requestGeneration)) {
    return null;
  }
  const health = data.health === undefined ? null : validateOutlineHealth(data.health);
  if (data.health !== undefined && health === null) return null;
  if (health !== null && health.generation !== data.generation) return null;
  if (data.availability === "complete") {
    const snapshot = validateOutlineSnapshot(data, { trustedGeometry: true });
    return snapshot === null
      ? null
      : {
          generation: data.generation,
          health,
          requestGeneration: data.requestGeneration,
          snapshot,
          type: "outline-snapshot",
        };
  }
  if (
    data.availability !== "absent" ||
    !Array.isArray(data.headings) ||
    data.headings.length !== 0 ||
    data.activeKey !== null ||
    !isRecord(data.proof) ||
    data.proof.complete !== false ||
    !finiteNonNegative(data.proof.clearancePx) ||
    typeof data.proof.reason !== "string" ||
    data.proof.reason.length > 128
  ) {
    return null;
  }
  return {
    generation: data.generation,
    health,
    requestGeneration: data.requestGeneration,
    snapshot: null,
    type: "outline-snapshot",
  };
};

/** overlay -> chrome */
export type OverlayMessage =
  | { readonly source: "lucid-overlay"; readonly type: "ready" }
  | {
      readonly source: "lucid-overlay";
      readonly type: "target-picked";
      readonly anchor: Anchor;
      /** Held modifier keys at pick time (additive - an old overlay omits it).
       *  The CHROME owns what they mean: meta collects into one draft, shift
       *  pins onto the open question's answer. The overlay only reports. */
      readonly modifiers?: { readonly meta: boolean; readonly shift: boolean };
      /** The marked decision this pick sits inside, when it sits inside one
       *  (additive). Resolved HERE because it needs the live DOM: the chrome
       *  cannot walk the artifact's ancestors across an opaque origin. Present
       *  for a pick on the marked element itself and for anything within it,
       *  so the composer can offer Agree / Decline either way - and so
       *  choosing one can answer the DECISION rather than the child that was
       *  clicked. */
      readonly decision?: Anchor;
    }
  | {
      readonly source: "lucid-overlay";
      readonly type: "annotation-hover";
      readonly id: string | null;
    }
  | { readonly source: "lucid-overlay"; readonly type: "annotation-activate"; readonly id: string }
  | { readonly source: "lucid-overlay"; readonly type: "selection-cleared" }
  /** Widest real child of the artifact body, measured inside the iframe. The
   *  chrome cannot measure it: the surface runs on an opaque origin (D-020), so
   *  `iframe.contentDocument` is null from the parent. */
  | { readonly source: "lucid-overlay"; readonly type: "content-width"; readonly width: number }
  /** Answer to `ping`, echoing its nonce so a reply can be attributed to the
   *  probe that asked for it rather than to one still in flight. */
  | { readonly source: "lucid-overlay"; readonly type: "pong"; readonly nonce: string }
  /** Every `data-lucid-id` present in the current artifact. The chrome can't see
   *  the artifact DOM (opaque origin), so the overlay reports it: a section
   *  permalink in chat is a live chip while its id is in this set, and degrades
   *  to plain text once it isn't. Republished on load and every swap. */
  | {
      readonly source: "lucid-overlay";
      readonly type: "section-ids";
      readonly ids: readonly string[];
      /** Sections whose stable ids appeared in the just-applied version, plus
       *  whether any part of each section was already in the artifact
       *  viewport at that moment. Absent on initial boot and older overlays. */
      readonly added?: readonly { readonly id: string; readonly inViewport: boolean }[];
    };

/** chrome -> overlay */
export type ChromeMessage =
  | {
      readonly source: "lucid-chrome";
      readonly type: "highlight";
      readonly annotations: readonly PayloadAnnotationLike[];
      readonly queued: readonly QueuedAnchorLike[];
      readonly pending: Anchor | null;
      /** Every spot of a cmd-collected draft, first entry == `pending`. An
       *  overlay that predates it paints `pending` alone (additive). */
      readonly pendingList?: readonly Anchor[];
      /**
       * False puts the surface in read mode: the overlay paints nothing and
       * stops targeting, so the artifact reads as plain document. It still
       * receives the anchors above and repaints instantly when this flips back.
       */
      readonly showTargets: boolean;
      /**
       * Which SENT annotations paint their mark (additive; an overlay that
       * predates it paints them all). Sent marks are quiet by default - the
       * feedback has been delivered, so its markup is noise on the artifact -
       * and each card can pin its own mark back on. The full list still rides
       * in `annotations` above: numbering and card↔mark focus follow the
       * record, not the subset that happens to be visible.
       */
      readonly shownCommitted?: readonly string[];
    }
  | {
      readonly source: "lucid-chrome";
      readonly type: "swap";
      readonly html: string;
      readonly revision?: number;
    }
  | { readonly source: "lucid-chrome"; readonly type: "focus-annotation"; readonly id: string }
  /** Focus a mark AND bring it into view. `focus-annotation` only lights the
   *  mark where it already is (pointer hover); this is the keyboard "open" -
   *  the reader is not looking at the surface, so it must scroll there. */
  | { readonly source: "lucid-chrome"; readonly type: "reveal-annotation"; readonly id: string }
  | { readonly source: "lucid-chrome"; readonly type: "reveal-section"; readonly lucidId: string }
  | { readonly source: "lucid-chrome"; readonly type: "pulse-section"; readonly lucidId: string }
  | { readonly source: "lucid-chrome"; readonly type: "request-section-ids" }
  | {
      readonly source: "lucid-chrome";
      readonly type: "diff-show";
      readonly html: string;
      readonly revision?: number;
    }
  | { readonly source: "lucid-chrome"; readonly type: "diff-goto"; readonly hunkId: string }
  | { readonly source: "lucid-chrome"; readonly type: "clear-pending" }
  /** Ask the overlay to measure the artifact's content width. */
  | { readonly source: "lucid-chrome"; readonly type: "measure-content" }
  /**
   * A round trip that does nothing, answered by `pong` with the same `nonce`.
   *
   * For proving that everything sent BEFORE it has been handled. The overlay
   * services messages synchronously and in order, so a `pong` is evidence that
   * the earlier message was processed - which is the only way to observe a
   * chrome action whose correct outcome is that the artifact does NOT change.
   * Deliberately inert: any real message borrowed for this purpose would carry
   * its own effect, and a probe that resizes the panel to answer a question is
   * not a probe.
   */
  | { readonly source: "lucid-chrome"; readonly type: "ping"; readonly nonce: string }
  /**
   * Which palette the artifact renders in. The DECISION is the human's and
   * belongs to the tool, not the document: an artifact must render identically
   * from disk, offline, so it may not carry a toggle or its persisted state
   * (see the lucid-design skill). Lucid holds the preference and tells every
   * open artifact at once.
   */
  | {
      readonly source: "lucid-chrome";
      readonly type: "theme";
      readonly theme: "light" | "dark";
    };
export const isOverlayMessage = (data: unknown): data is OverlayMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-overlay";

export const isChromeMessage = (data: unknown): data is ChromeMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "lucid-chrome";

/** The bound on section-ids the overlay may report. Deliberately larger than the
 *  private port's 64-heading cap (headings are a subset of sections): a plan
 *  artifact carries hundreds of data-lucid-ids, and discarding the tail would
 *  silently break every section permalink past the cut. */
export const MAX_OVERLAY_SECTION_IDS = 512;

export type OverlayValidationRecord =
  | { readonly kind: "refusal"; readonly type: string; readonly field: string }
  | {
      readonly kind: "truncation";
      readonly type: string;
      readonly field: string;
      readonly original: number;
      readonly kept: number;
    };

/** Validate a public-channel overlay message (the artifact shares the overlay's
 *  JS realm, so inbound data is untrusted). Returns the typed message, or null
 *  when the shape or a field's bounds are wrong; `onRecord` receives a refusal
 *  or truncation record for observability. */
export const validateOverlayMessage = (
  data: unknown,
  onRecord?: (record: OverlayValidationRecord) => void,
): OverlayMessage | null => {
  if (!isRecord(data) || data.source !== "lucid-overlay") return null;
  const type = data.type;
  const refuse = (field: string): null => {
    onRecord?.({ field, kind: "refusal", type: String(type) });
    return null;
  };

  switch (type) {
    case "ready":
      return { source: "lucid-overlay", type: "ready" };
    case "target-picked": {
      if (!isRecord(data.anchor)) return refuse("anchor");
      return {
        source: "lucid-overlay",
        type: "target-picked",
        anchor: data.anchor as unknown as Anchor,
      };
    }
    case "annotation-hover":
      if (data.id !== null && typeof data.id !== "string") return refuse("id");
      return {
        source: "lucid-overlay",
        type: "annotation-hover",
        id: data.id as string | null,
      };
    case "annotation-activate":
      if (typeof data.id !== "string") return refuse("id");
      return { source: "lucid-overlay", type: "annotation-activate", id: data.id };
    case "selection-cleared":
      return { source: "lucid-overlay", type: "selection-cleared" };
    case "content-width": {
      const width = data.width;
      if (typeof width !== "number" || !Number.isFinite(width) || width <= 0)
        return refuse("width");
      return { source: "lucid-overlay", type: "content-width", width };
    }
    case "pong":
      if (typeof data.nonce !== "string") return refuse("nonce");
      return { source: "lucid-overlay", type: "pong", nonce: data.nonce };
    case "section-ids": {
      if (!Array.isArray(data.ids)) return refuse("ids");
      const ids = data.ids.filter((id): id is string => typeof id === "string");
      if (ids.length > MAX_OVERLAY_SECTION_IDS) {
        onRecord?.({
          field: "ids",
          kind: "truncation",
          kept: MAX_OVERLAY_SECTION_IDS,
          original: ids.length,
          type: "section-ids",
        });
        return {
          source: "lucid-overlay",
          type: "section-ids",
          ids: ids.slice(0, MAX_OVERLAY_SECTION_IDS),
          ...(Array.isArray(data.added)
            ? {
                added: data.added as readonly {
                  readonly id: string;
                  readonly inViewport: boolean;
                }[],
              }
            : {}),
        };
      }
      return {
        source: "lucid-overlay",
        type: "section-ids",
        ids,
        ...(Array.isArray(data.added)
          ? {
              added: data.added as readonly { readonly id: string; readonly inViewport: boolean }[],
            }
          : {}),
      };
    }
    default:
      return null;
  }
};
