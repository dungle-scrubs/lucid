import { describe, expect, test } from "bun:test";
import {
  applyInboundMessage,
  type InboundHandlers,
  type InboundSurface,
} from "../client/chrome/inbound.ts";
import type { OverlayMessage } from "../client/shared/protocol.ts";

/** A recording surface: every method is a spy. frameRect returns a fixed rect
 *  so selection-copy translation is deterministic. */
const surface = (
  frameRect: DOMRect | null = null,
): InboundSurface & {
  readonly ready: number;
  readonly pushed: number;
} => {
  let ready = 0;
  let pushed = 0;
  return {
    markOverlayReady: () => {
      ready += 1;
    },
    pushHighlights: () => {
      pushed += 1;
    },
    frameRect: () => frameRect,
    get ready() {
      return ready;
    },
    get pushed() {
      return pushed;
    },
  };
};

/** A recording handlers bag: every call captured. */
const handlers = (): InboundHandlers & {
  readonly calls: readonly string[];
} => {
  const calls: string[] = [];
  return {
    applyOverlayMessage: (msg) =>
      calls.push(
        `target-picked:${(msg as { anchor?: { domPath?: string } }).anchor?.domPath ?? ""}`,
      ),
    setHoveredId: (id) => calls.push(`hover:${id ?? "null"}`),
    setChromeWidth: (w) => calls.push(`width:${w}`),
    persistWidth: (w) => calls.push(`persist:${w}`),
    scrollAnnotationIntoView: (id) => calls.push(`scroll:${id}`),
    setSections: (ids, added) => calls.push(`sections:${ids.length}:${added?.length ?? "none"}`),
    dispatchCopy: (event) => {
      if (event.kind === "collapse") {
        calls.push("copy:collapse");
        return;
      }
      if (event.kind === "selection-copy") {
        calls.push(`copy:selection:${event.text}:${event.anchorRect.x},${event.anchorRect.y}`);
        return;
      }
      calls.push(`copy:${event.kind}`);
    },
    get calls() {
      return calls;
    },
  };
};

const msg = (over: OverlayMessage): OverlayMessage => over;

describe("applyInboundMessage", () => {
  test("ready marks the overlay ready and pushes highlights", () => {
    const s = surface();
    applyInboundMessage(msg({ source: "lucid-overlay", type: "ready" }), s, handlers(), 1000);
    expect(s.ready).toBe(1);
    expect(s.pushed).toBe(1);
  });

  test("target-picked is handed to the overlay-message applier", () => {
    const h = handlers();
    applyInboundMessage(
      msg({
        source: "lucid-overlay",
        type: "target-picked",
        anchor: {
          kind: "element",
          lucidId: "h",
          fingerprint: "f",
          domPath: "h1",
          snippet: "Hello",
        },
      }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual(["target-picked:h1"]);
  });

  test("annotation-hover sets the hovered id (null allowed)", () => {
    const h = handlers();
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "annotation-hover", id: "a1" }),
      surface(),
      h,
      1000,
    );
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "annotation-hover", id: null }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual(["hover:a1", "hover:null"]);
  });

  test("content-width sizes the chrome to the content, floored at the minimum", () => {
    const h = handlers();
    // 1000 viewport, 400 content, 5 divider -> 1000 - 5 - 400 = 595.
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "content-width", width: 400 }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual(["width:595", "persist:595"]);
  });

  test("content-width falls back to the default when nothing is measurable", () => {
    const h = handlers();
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "content-width", width: 0 }),
      surface(),
      h,
      1000,
    );
    expect(h.calls.length).toBe(2);
    expect(h.calls[0]).toMatch(/^width:/);
    expect(h.calls[1]).toBe(`persist:${(h.calls[0] ?? "").split(":")[1]}`);
  });

  test("annotation-activate sets hover and scrolls the card into view", () => {
    const h = handlers();
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "annotation-activate", id: "a2" }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual(["hover:a2", "scroll:a2"]);
  });

  test("section-ids carries both the ids and the added-visibility report", () => {
    const h = handlers();
    applyInboundMessage(
      msg({
        source: "lucid-overlay",
        type: "section-ids",
        ids: ["s1", "s2"],
        added: [{ id: "s2", inViewport: true }],
      }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual(["sections:2:1"]);
  });

  test("selection-copy translates the release point by the frame origin and opens at it", () => {
    const h = handlers();
    // frame at (100, 200); release at (10, 20) inside the iframe -> (110, 220).
    const frame = {
      left: 100,
      top: 200,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 100,
      y: 200,
    } as DOMRect;
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "selection-copy", text: "hi", x: 10, y: 20 }),
      surface(frame),
      h,
      1000,
    );
    expect(h.calls).toEqual(["copy:selection:hi:110,220"]);
  });

  test("selection-copy is dropped when no frame is attached", () => {
    const h = handlers();
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "selection-copy", text: "hi", x: 1, y: 1 }),
      surface(null),
      h,
      1000,
    );
    expect(h.calls).toEqual([]);
  });

  test("selection-collapsed dismisses an open popover", () => {
    const h = handlers();
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "selection-collapsed" }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual(["copy:collapse"]);
  });

  test("a non-state type (pong) is a no-op", () => {
    const h = handlers();
    applyInboundMessage(
      msg({ source: "lucid-overlay", type: "pong", nonce: "n" }),
      surface(),
      h,
      1000,
    );
    expect(h.calls).toEqual([]);
  });
});
