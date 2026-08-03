/**
 * Adapts pre-artifact browser capabilities and the private MessagePort to the
 * pure outline runtime. It owns observers and lifecycle wiring, but not the
 * projection policy, visible parent control, or legacy annotation transport.
 */

import {
  ARTIFACT_OUTLINE_POLICY,
  type OutlineRuntimePublication,
} from "../shared/artifact-outline.ts";
import { type OutlinePrivateOutbound, validateOutlinePrivateInbound } from "../shared/protocol.ts";
import {
  type ArtifactOutlineDebugInfo,
  type ArtifactOutlineGeometry,
  ArtifactOutlineRuntime,
  type OutlineRuntimeElement,
  type OutlineRuntimeMap,
  type OutlineRuntimeRect,
  type OutlineRuntimeStyle,
  type OutlineRuntimeWeakMap,
} from "./artifact-outline-runtime.ts";
import type { EmphasisEnvironment } from "./reveal.ts";

export interface TrustedOutlineCapabilities {
  readonly allElements: (
    limit: number,
    deadlineMs: number,
  ) => { readonly complete: boolean; readonly elements: readonly Element[] };
  readonly ariaHidden: (element: Element) => boolean;
  readonly clientHeight: (element: Element) => number;
  readonly clientWidth: (element: Element) => number;
  readonly createMap: <Key, Value>() => OutlineRuntimeMap<Key, Value>;
  readonly createWeakMap: <Key extends object, Value>() => OutlineRuntimeWeakMap<Key, Value>;
  readonly proofRealmTrusted: () => boolean;
  readonly hasActiveMotion: (element: Element) => boolean;
  readonly hidden: (element: Element) => boolean;
  readonly inert: (element: Element) => boolean;
  readonly isConnected: (element: Element) => boolean;
  readonly isLightDom: (element: Element) => boolean;
  readonly isOwned: (element: Element) => boolean;
  readonly isSettled: () => boolean;
  readonly now: () => number;
  readonly observeMutations: (callback: () => void) => () => void;
  readonly observeResize: (callback: () => void) => () => void;
  readonly observeStyleActivity: (callback: () => void) => () => void;
  readonly onDocumentLoad: (callback: () => void) => () => void;
  readonly onFontsSettled: (callback: () => void) => () => void;
  readonly onFrameDetach: (callback: () => void) => () => void;
  readonly onWindowResize: (callback: () => void) => () => void;
  readonly onWindowScroll: (callback: () => void) => () => void;
  readonly parentElement: (element: Element) => Element | null;
  readonly pseudoContent: (element: Element) => { readonly after: string; readonly before: string };
  readonly rect: (element: Element) => OutlineRuntimeRect;
  readonly scheduleFrame: (callback: () => void) => () => void;
  readonly scheduleQuiet: (delayMs: number, callback: () => void) => () => void;
  readonly scrollHeight: (element: Element) => number;
  readonly scrollWidth: (element: Element) => number;
  readonly style: (element: Element) => OutlineRuntimeStyle;
  readonly styleRealmTrusted: () => boolean;
  readonly tagName: (element: Element) => string;
  readonly text: (
    element: Element,
    maxCodeUnits: number,
    maxNodes: number,
    deadlineMs: number,
  ) => {
    readonly complete: boolean;
    readonly examinedNodes: number;
    readonly value: string;
  };
  readonly viewport: () => {
    readonly clientWidth: number;
    readonly height: number;
    readonly width: number;
  };
}

/**
 * The pre-artifact bootstrap owns the raw MessagePort and exposes only these
 * captured operations. Artifact code can mutate MessagePort.prototype before
 * this module evaluates, so the controller must never invoke it directly.
 */
export interface TrustedOutlinePort {
  readonly close: () => void;
  readonly listen: (onMessage: (data: unknown) => void, onClose: () => void) => () => void;
  readonly post: (message: unknown) => void;
}

interface BrowserElement extends OutlineRuntimeElement {
  readonly nativeElement: Element;
  parent: BrowserElement | null;
}

const snapshotGeometry = (
  capabilities: TrustedOutlineCapabilities,
  deadlineMs: number,
): {
  readonly completeTraversal: boolean;
  readonly elements: readonly BrowserElement[];
  readonly headings: readonly BrowserElement[];
} => {
  const traversal = capabilities.allElements(
    ARTIFACT_OUTLINE_POLICY.proofElementLimit + 1,
    deadlineMs,
  );
  const completeTraversal =
    traversal.complete && traversal.elements.length <= ARTIFACT_OUTLINE_POLICY.proofElementLimit;
  const boundedElements = traversal.elements.slice(0, ARTIFACT_OUTLINE_POLICY.proofElementLimit);
  const byNative = capabilities.createMap<Element, BrowserElement>();
  const elements: BrowserElement[] = [];
  let wrappedTraversal = completeTraversal;
  for (const nativeElement of boundedElements) {
    if (capabilities.now() > deadlineMs) {
      wrappedTraversal = false;
      break;
    }
    const tagName = capabilities.tagName(nativeElement);
    const parentElement = capabilities.parentElement(nativeElement);
    const parent = parentElement ? (byNative.get(parentElement) ?? null) : null;
    let cachedRect: OutlineRuntimeRect | undefined;
    let cachedStyle: OutlineRuntimeStyle | undefined;
    let cachedText:
      | { readonly complete: boolean; readonly examinedNodes: number; readonly value: string }
      | undefined;
    const snapshot: BrowserElement = {
      get activeMotion() {
        return capabilities.hasActiveMotion(nativeElement);
      },
      get ariaHidden() {
        return capabilities.ariaHidden(nativeElement);
      },
      get clientHeight() {
        return capabilities.clientHeight(nativeElement);
      },
      get clientWidth() {
        return capabilities.clientWidth(nativeElement);
      },
      get connected() {
        return capabilities.isConnected(nativeElement);
      },
      get hasBox() {
        cachedRect ??= capabilities.rect(nativeElement);
        return cachedRect.right > cachedRect.left || cachedRect.bottom > cachedRect.top;
      },
      get hidden() {
        return capabilities.hidden(nativeElement);
      },
      get inert() {
        return capabilities.inert(nativeElement);
      },
      get lightDom() {
        return capabilities.isLightDom(nativeElement);
      },
      nativeElement,
      owned: tagName === "HTML" || tagName === "BODY" || capabilities.isOwned(nativeElement),
      parent,
      get rect() {
        cachedRect ??= capabilities.rect(nativeElement);
        return cachedRect;
      },
      rootScroller: tagName === "HTML" || tagName === "BODY",
      get scrollHeight() {
        return capabilities.scrollHeight(nativeElement);
      },
      get scrollWidth() {
        return capabilities.scrollWidth(nativeElement);
      },
      get style() {
        cachedStyle ??= capabilities.style(nativeElement);
        return cachedStyle;
      },
      tagName,
      get text() {
        if (tagName !== "H2") return "";
        cachedText ??= capabilities.text(
          nativeElement,
          ARTIFACT_OUTLINE_POLICY.maxExaminedLabelCodeUnits + 1,
          ARTIFACT_OUTLINE_POLICY.maxTextNodesPerHeading,
          deadlineMs,
        );
        return cachedText.value;
      },
      get textComplete() {
        if (tagName !== "H2") return true;
        cachedText ??= capabilities.text(
          nativeElement,
          ARTIFACT_OUTLINE_POLICY.maxExaminedLabelCodeUnits + 1,
          ARTIFACT_OUTLINE_POLICY.maxTextNodesPerHeading,
          deadlineMs,
        );
        return cachedText.complete;
      },
      get textNodesExamined() {
        if (tagName !== "H2") return 0;
        cachedText ??= capabilities.text(
          nativeElement,
          ARTIFACT_OUTLINE_POLICY.maxExaminedLabelCodeUnits + 1,
          ARTIFACT_OUTLINE_POLICY.maxTextNodesPerHeading,
          deadlineMs,
        );
        return cachedText.examinedNodes;
      },
    };
    byNative.set(nativeElement, snapshot);
    elements.push(snapshot);
  }
  return {
    completeTraversal: wrappedTraversal,
    elements,
    headings: elements.filter(({ tagName }) => tagName === "H2"),
  };
};

const toOutbound = (publication: OutlineRuntimePublication): OutlinePrivateOutbound => {
  if (publication.type === "snapshot") {
    return { ...publication, type: "outline-snapshot" };
  }
  if (publication.type === "active") return { ...publication, type: "outline-active" };
  return { ...publication, type: "outline-invalidated" };
};

export class BrowserArtifactOutlineController {
  readonly #capabilities: TrustedOutlineCapabilities;
  readonly #emphasis: EmphasisEnvironment;
  readonly #port: TrustedOutlinePort;
  #runtime: ArtifactOutlineRuntime<BrowserElement>;
  #connected = true;
  #started = false;
  #stops: (() => void)[] = [];
  #stopFrameDetach: (() => void) | null;
  readonly #stopPort: () => void;
  #transportPublications = 0;

  constructor(
    port: TrustedOutlinePort,
    capabilities: TrustedOutlineCapabilities,
    emphasis: EmphasisEnvironment,
  ) {
    this.#port = port;
    this.#capabilities = capabilities;
    this.#emphasis = emphasis;
    this.#runtime = this.#createRuntime();
    this.#stopFrameDetach = this.#capabilities.onFrameDetach(() => this.#detachFrame());
    this.#stopPort = this.#port.listen(this.#onMessage, this.#onClose);
  }

  revise(): void {
    this.#runtime.revise();
  }

  revisionComplete(revision: number): void {
    if (!this.#connected) return;
    this.#post({ revision, type: "outline-revision-complete" });
  }

  disconnect(): void {
    this.#shutdown({ closePort: true, notifyDetach: false });
  }

  #detachFrame(): void {
    this.#shutdown({ closePort: false, notifyDetach: true });
  }

  #shutdown(policy: { readonly closePort: boolean; readonly notifyDetach: boolean }): void {
    if (!this.#connected) return;
    if (policy.notifyDetach) {
      // Authenticate the document boundary over the private port before this
      // realm disappears. The parent can then release its old endpoint before
      // the replacement document offers its own pre-artifact channel.
      this.#post({ type: "outline-frame-detaching" });
    }
    this.#connected = false;
    this.#runtime.disconnect();
    this.#stopObservers();
    this.#stopFrameDetach?.();
    this.#stopFrameDetach = null;
    this.#stopPort();
    if (policy.closePort) this.#port.close();
    // A detaching realm leaves its local endpoint open so the queued notice
    // remains deliverable. The parent closes its endpoint after receiving it.
  }

  debugInfo(): ArtifactOutlineDebugInfo & { readonly transportPublications: number } {
    return {
      ...this.#runtime.debugInfo(),
      transportPublications: this.#transportPublications,
    };
  }

  #createRuntime(): ArtifactOutlineRuntime<BrowserElement> {
    let current: ReturnType<typeof snapshotGeometry> | null = null;
    const geometry: ArtifactOutlineGeometry<BrowserElement> = {
      allElements: () => current?.elements ?? [],
      completeTraversal: (deadlineMs) => {
        current = snapshotGeometry(this.#capabilities, deadlineMs);
        return current.completeTraversal;
      },
      headingCandidates: () => current?.headings ?? [],
      isSettled: this.#capabilities.isSettled,
      parentElement: (element) => element.parent,
      pseudoContent: (element) => this.#capabilities.pseudoContent(element.nativeElement),
      rect: (element) => this.#capabilities.rect(element.nativeElement),
      proofRealmTrusted: this.#capabilities.proofRealmTrusted,
      styleRealmTrusted: this.#capabilities.styleRealmTrusted,
      viewport: this.#capabilities.viewport,
    };
    return new ArtifactOutlineRuntime({
      createMap: this.#capabilities.createMap,
      createWeakMap: this.#capabilities.createWeakMap,
      geometry,
      now: this.#capabilities.now,
      onProofRealmRejected: () => this.#stopObservers(),
      publish: (publication) => this.#post(toOutbound(publication)),
      scheduleFrame: this.#capabilities.scheduleFrame,
      scheduleQuiet: this.#capabilities.scheduleQuiet,
    });
  }

  #startObservers(): void {
    if (this.#started) return;
    this.#started = true;
    const invalidate = (): void => this.#runtime.invalidate("layout-observer");
    this.#stops.push(
      this.#capabilities.observeMutations(invalidate),
      this.#capabilities.observeResize(invalidate),
      this.#capabilities.observeStyleActivity(invalidate),
      this.#capabilities.onDocumentLoad(invalidate),
      this.#capabilities.onFontsSettled(invalidate),
      this.#capabilities.onWindowResize(invalidate),
      // Scrolling cannot change which headings a document has - only which one
      // is active, and where the pinned panel may sit. So the proof yields (the
      // panel steps back to the rail) and the projection stays up, instead of
      // the whole outline unmounting for the length of the scroll.
      this.#capabilities.onWindowScroll(() => {
        this.#runtime.invalidateGeometry("root-scroll");
      }),
    );
  }

  #stopObservers(): void {
    const stops = this.#stops;
    this.#stops = [];
    for (let index = 0; index < stops.length; index += 1) stops[index]?.();
    this.#started = false;
  }

  readonly #onMessage = (data: unknown): void => {
    // The quiet projection checks again before proof work. This first check is
    // the synchronous gate that keeps poisoned validators and observer-array
    // methods from running while handling the request itself.
    if (!this.#capabilities.proofRealmTrusted()) {
      this.#runtime.rejectUntrustedProofRealm();
      return;
    }
    const message = validateOutlinePrivateInbound(data);
    if (message === null) return;
    if (message.type === "outline-suspend") {
      this.#runtime.suspend();
      this.#stopObservers();
      return;
    }
    if (message.type === "outline-layout-request") {
      this.#startObservers();
      this.#runtime.requestLayout(message);
      return;
    }
    this.#runtime.activate(message, message.motion, {
      ...this.#emphasis,
      invalidate: (record) => this.#runtime.invalidateWithHealth(record),
    });
  };

  readonly #onClose = (): void => this.disconnect();

  #post(message: OutlinePrivateOutbound): void {
    this.#transportPublications += 1;
    this.#port.post(message);
  }
}
