import { describe, expect, test } from "bun:test";
import {
  BrowserArtifactOutlineController,
  type TrustedOutlineCapabilities,
} from "../client/overlay/browser-artifact-outline.ts";

class FakePort extends EventTarget {
  closed = false;
  readonly messages: unknown[] = [];

  close(): void {
    this.closed = true;
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  start(): void {}

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const capabilitiesHarness = () => {
  const active = new Set<string>();
  const stopped = new Set<string>();
  const callbacks = new Map<string, () => void>();
  const observe =
    (name: string) =>
    (callback: () => void): (() => void) => {
      active.add(name);
      callbacks.set(name, callback);
      return () => stopped.add(name);
    };
  const capabilities: TrustedOutlineCapabilities = {
    allElements: () => ({ complete: true, elements: [] }),
    ariaHidden: () => false,
    clientHeight: () => 0,
    clientWidth: () => 0,
    hasActiveMotion: () => false,
    hidden: () => false,
    inert: () => false,
    isConnected: () => true,
    isLightDom: () => true,
    isOwned: () => false,
    isSettled: () => true,
    now: () => 0,
    observeMutations: observe("mutations"),
    observeResize: observe("resize"),
    observeStyleActivity: observe("style-activity"),
    onDocumentLoad: observe("document-load"),
    onFontsSettled: observe("fonts"),
    onFrameDetach: observe("frame-detach"),
    onWindowResize: observe("window-resize"),
    onWindowScroll: observe("window-scroll"),
    parentElement: () => null,
    pseudoContent: () => ({ after: "none", before: "none" }),
    rect: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
    scheduleFrame: () => () => undefined,
    scheduleQuiet: () => () => undefined,
    scrollHeight: () => 0,
    scrollWidth: () => 0,
    style: () => ({
      boxShadow: "none",
      clipPath: "none",
      display: "block",
      filter: "none",
      opacity: "1",
      outlineStyle: "none",
      outlineWidth: "0px",
      overflowX: "visible",
      overflowY: "visible",
      position: "static",
      textShadow: "none",
      transform: "none",
      visibility: "visible",
    }),
    styleRealmTrusted: () => true,
    tagName: () => "DIV",
    text: () => ({ complete: true, examinedNodes: 0, value: "" }),
    viewport: () => ({ clientWidth: 1_600, height: 900, width: 1_600 }),
  };
  return { active, callbacks, capabilities, stopped };
};

describe("BrowserArtifactOutlineController lifecycle", () => {
  test("stays observer-free until a valid request and cancels every observer on pagehide", () => {
    const port = new FakePort();
    const harness = capabilitiesHarness();
    const controller = new BrowserArtifactOutlineController(
      port as unknown as MessagePort,
      harness.capabilities,
      {
        clearEmphasis: () => undefined,
        ensureStyles: () => undefined,
      },
    );

    expect(controller.debugInfo()).toMatchObject({ dormant: true, connected: true });
    expect(harness.active.size).toBe(0);
    port.receive({
      type: "outline-layout-request",
      generation: -1,
      preferredWidth: Number.POSITIVE_INFINITY,
      safeInsets: { bottom: 0, right: 0, top: 0 },
    });
    expect(harness.active.size).toBe(0);

    port.receive({
      type: "outline-layout-request",
      generation: 1,
      preferredWidth: 240,
      safeInsets: { bottom: 24, right: 16, top: 80 },
    });
    expect(controller.debugInfo()).toMatchObject({ dormant: false, pendingQuietTask: true });
    expect(harness.active).toEqual(
      new Set([
        "mutations",
        "resize",
        "style-activity",
        "document-load",
        "fonts",
        "frame-detach",
        "window-resize",
        "window-scroll",
      ]),
    );

    harness.callbacks.get("frame-detach")?.();
    expect(controller.debugInfo()).toMatchObject({ connected: false, pendingQuietTask: false });
    expect(harness.stopped).toEqual(harness.active);
    expect(port.closed).toBe(true);
  });
});
