import { describe, expect, test } from "bun:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { FRAME_MESSAGE_SOURCE, instrumentArtifact } from "../../src/server/client/instrument.js";

describe("artifact reading place handshake", () => {
  test("waits for layout and the restore before reporting, then reports every scroll immediately", async () => {
    const messages: Record<string, unknown>[] = [];
    let finishFonts = (): void => {};
    const fonts = new Promise<void>((resolve) => {
      finishFonts = resolve;
    });
    let scroll = 0;
    const dom = new JSDOM(instrumentArtifact("<p>First</p><p>Second</p>", "doc", 1), {
      beforeParse(window) {
        Object.defineProperty(window.document, "fonts", { value: { ready: fonts } });
        window.postMessage = (message: Record<string, unknown>): void => {
          messages.push(message);
        };
        window.HTMLElement.prototype.getBoundingClientRect = function () {
          const top = (this.textContent === "Second" ? 1000 : 0) - scroll;
          return {
            bottom: top + 100,
            height: 100,
            left: 0,
            right: 100,
            top,
            width: 100,
            x: 0,
            y: top,
            toJSON: () => ({}),
          };
        };
        window.scrollBy = ((options: ScrollToOptions) => {
          expect(options.behavior).toBe("instant");
          scroll += options.top ?? 0;
        }) as typeof window.scrollBy;
      },
      virtualConsole: new VirtualConsole(),
    });
    try {
      // Execute the production instrumentation against this DOM directly.
      // Bun's vm context cannot run jsdom's proxy-backed global object.
      const script = dom.window.document.querySelector("script[data-lucid]")?.textContent;
      if (!script) throw new Error("Missing frame instrumentation");
      new Function(
        "window",
        "document",
        "parent",
        "MutationObserver",
        "Element",
        "setTimeout",
        script,
      )(
        dom.window,
        dom.window.document,
        dom.window,
        dom.window.MutationObserver,
        dom.window.Element,
        dom.window.setTimeout.bind(dom.window),
      );
      await new Promise<void>((resolve) =>
        dom.window.addEventListener("load", () => resolve(), { once: true }),
      );
      expect(messages.some((message) => message.kind === "ready")).toBe(false);
      finishFonts();
      await Promise.resolve();
      expect(messages.some((message) => message.kind === "ready")).toBe(true);
      expect(messages.filter((message) => message.kind === "place")).toHaveLength(0);
      const send = (data: Record<string, unknown>): void => {
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            data: { source: FRAME_MESSAGE_SOURCE, ...data },
            source: dom.window as unknown as Window,
          }),
        );
      };
      send({ index: 1, kind: "restore-place", top: -43.625 });
      expect(scroll).toBe(1043.625);
      expect(messages.at(-1)).toMatchObject({ index: 1, kind: "place", top: -43.625 });
      scroll = 1050;
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
      expect(messages.at(-1)).toMatchObject({ index: 1, kind: "place", top: -50 });
      scroll = 1060;
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
      expect(messages.at(-1)).toMatchObject({ index: 1, kind: "place", top: -60 });
      scroll = 0;
      send({ kind: "report-place" });
      expect(messages.at(-1)).toMatchObject({ index: 0, kind: "place", top: 0 });
    } finally {
      dom.window.close();
    }
  });
});
