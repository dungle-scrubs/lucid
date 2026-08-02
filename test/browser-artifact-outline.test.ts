import { describe, expect, test } from "bun:test";
import {
  BrowserArtifactOutlineController,
  type TrustedOutlineCapabilities,
  type TrustedOutlinePort,
} from "../client/overlay/browser-artifact-outline.ts";

class FakePort extends EventTarget implements TrustedOutlinePort {
  closed = false;
  readonly messages: unknown[] = [];

  close(): void {
    this.closed = true;
  }

  post(message: unknown): void {
    this.messages.push(message);
  }

  listen(onMessage: (data: unknown) => void, onClose: () => void): () => void {
    const messageListener = (event: Event): void =>
      onMessage((event as MessageEvent<unknown>).data);
    this.addEventListener("message", messageListener);
    this.addEventListener("close", onClose);
    return () => {
      this.removeEventListener("message", messageListener);
      this.removeEventListener("close", onClose);
    };
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const capabilitiesHarness = () => {
  const proofTrust = { current: true };
  const active = new Set<string>();
  const stopped = new Set<string>();
  const callbacks = new Map<string, () => void>();
  const quietTasks: (() => void)[] = [];
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
    createMap: () => new Map(),
    createWeakMap: () => new WeakMap(),
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
    proofRealmTrusted: () => proofTrust.current,
    rect: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
    scheduleFrame: () => () => undefined,
    scheduleQuiet: (_delayMs, callback) => {
      let cancelled = false;
      quietTasks.push(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    },
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
  return { active, callbacks, capabilities, proofTrust, quietTasks, stopped };
};

const expectNonDetachObserversStopped = (
  active: ReadonlySet<string>,
  stopped: ReadonlySet<string>,
): void => {
  expect(stopped).toEqual(new Set([...active].filter((name) => name !== "frame-detach")));
  expect(stopped).not.toContain("frame-detach");
};

describe("BrowserArtifactOutlineController lifecycle", () => {
  test("trust failure withdraws the runtime and stops every active observer", () => {
    const port = new FakePort();
    const harness = capabilitiesHarness();
    const controller = new BrowserArtifactOutlineController(port, harness.capabilities, {
      clearEmphasis: () => undefined,
      ensureStyles: () => undefined,
    });
    port.receive({
      type: "outline-layout-request",
      generation: 1,
      preferredWidth: 240,
      safeInsets: { bottom: 24, right: 16, top: 80 },
    });
    expect(controller.debugInfo()).toMatchObject({ dormant: false, pendingQuietTask: true });

    harness.proofTrust.current = false;
    port.receive({ type: "outline-suspend" });

    expect(controller.debugInfo()).toMatchObject({ pendingQuietTask: false, proofComplete: false });
    expectNonDetachObserversStopped(harness.active, harness.stopped);
  });

  test("delayed trust failure stops every active observer", () => {
    const port = new FakePort();
    const harness = capabilitiesHarness();
    const controller = new BrowserArtifactOutlineController(port, harness.capabilities, {
      clearEmphasis: () => undefined,
      ensureStyles: () => undefined,
    });
    port.receive({
      type: "outline-layout-request",
      generation: 1,
      preferredWidth: 240,
      safeInsets: { bottom: 24, right: 16, top: 80 },
    });

    harness.proofTrust.current = false;
    for (const task of harness.quietTasks.splice(0)) task();

    expect(controller.debugInfo()).toMatchObject({ pendingQuietTask: false, proofComplete: false });
    expectNonDetachObserversStopped(harness.active, harness.stopped);
  });

  test("keeps frame detach observed while dormant and cancels every observer on pagehide", () => {
    const port = new FakePort();
    const harness = capabilitiesHarness();
    const controller = new BrowserArtifactOutlineController(port, harness.capabilities, {
      clearEmphasis: () => undefined,
      ensureStyles: () => undefined,
    });

    expect(controller.debugInfo()).toMatchObject({ dormant: true, connected: true });
    expect(harness.active).toEqual(new Set(["frame-detach"]));
    port.receive({
      type: "outline-layout-request",
      generation: -1,
      preferredWidth: Number.POSITIVE_INFINITY,
      safeInsets: { bottom: 0, right: 0, top: 0 },
    });
    expect(harness.active).toEqual(new Set(["frame-detach"]));

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
        "window-resize",
        "window-scroll",
        "frame-detach",
      ]),
    );

    port.receive({ type: "outline-suspend" });
    expect(controller.debugInfo()).toMatchObject({
      connected: true,
      dormant: true,
      pendingQuietTask: false,
    });
    expect(harness.stopped).not.toContain("frame-detach");
    expect(port.closed).toBe(false);

    controller.revisionComplete(7);
    expect(port.messages.at(-1)).toEqual({ revision: 7, type: "outline-revision-complete" });

    harness.stopped.clear();
    port.receive({
      type: "outline-layout-request",
      generation: 2,
      preferredWidth: 240,
      safeInsets: { bottom: 24, right: 16, top: 80 },
    });
    expect(controller.debugInfo()).toMatchObject({ dormant: false, pendingQuietTask: true });

    harness.callbacks.get("frame-detach")?.();
    expect(controller.debugInfo()).toMatchObject({ connected: false, pendingQuietTask: false });
    expect(harness.stopped).toEqual(harness.active);
    expect(port.messages.at(-1)).toEqual({ type: "outline-frame-detaching" });
    expect(port.closed).toBe(false);
  });
});
