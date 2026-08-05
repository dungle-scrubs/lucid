import { describe, expect, test } from "bun:test";
import {
  nextCopyPopoverState,
  translateToViewport,
  type CopyPopoverAnchor,
  type CopyPopoverEvent,
  type CopyPopoverState,
  type ViewportOrigin,
} from "../client/chrome/selection-copy.ts";

/**
 * The pure half of the copy Popover's coordinate math.
 *
 * `translateToViewport` answers ONE question: given the artifact iframe's
 * bounding rect (parent-viewport coords) and the release point the overlay
 * posted (iframe-viewport coords), where is that point in the PARENT viewport?
 * The answer is two additions; the point of pulling it out is the same as
 * `keymap.ts` / `copy-keymap.ts`'s split (D-018): a function a browser is the
 * wrong instrument for measuring, hoisted out of the wiring so the table is
 * cheap to cover. What stays in the wiring (and in e2e) is that the iframe
 * rect really is THIS session's own iframe, and that the translated point
 * really lands where the selection ended.
 */

const origin = (over: Partial<ViewportOrigin> = {}): ViewportOrigin => ({
  left: 100,
  top: 50,
  ...over,
});

describe("translateToViewport", () => {
  test("adds the iframe rect's origin to the in-iframe release point", () => {
    // A release at (20, 10) inside an iframe whose top-left sits at (100, 50)
    // in the parent viewport lands at (120, 60) - where the Popover anchors.
    expect(translateToViewport(origin(), 20, 10)).toEqual({ x: 120, y: 60 });
  });

  test("respects a rect pinned at the viewport origin", () => {
    expect(translateToViewport(origin({ left: 0, top: 0 }), 5, 7)).toEqual({ x: 5, y: 7 });
  });

  test("respects a rect offset to the right and below (a centered surface)", () => {
    expect(translateToViewport(origin({ left: 320, top: 0 }), 40, 200)).toEqual({
      x: 360,
      y: 200,
    });
  });

  test("handles a release at the iframe's own origin", () => {
    expect(translateToViewport(origin({ left: 240, top: 180 }), 0, 0)).toEqual({
      x: 240,
      y: 180,
    });
  });

  test("handles negative in-iframe coords (a selection released off-edge)", () => {
    // Scrolling the artifact can put content above/left of the iframe origin;
    // clientX/clientY can be negative, and the translation must still land in
    // the parent viewport.
    expect(translateToViewport(origin({ left: 300, top: 200 }), -50, -30)).toEqual({
      x: 250,
      y: 170,
    });
  });
});

/**
 * The copy Popover's dismissal state machine, as a pure reducer.
 *
 * `nextCopyPopoverState` owns the Popover's open/close table: which event
 * opens it, which replaces it, which closes it. The whole point of pulling it
 * out (D-004) is that the lifecycle is a TABLE - and a table is cheap to
 * exhaustively cover where a browser (React state, real events, the clipboard)
 * is expensive and flaky. The DOM/React wiring dispatches these events; this
 * reducer decides. Sibling of `translateToViewport` and the same D-018 split
 * as `keymap.ts`.
 */

const anchor = (over: Partial<CopyPopoverAnchor> = {}): CopyPopoverAnchor => ({
  left: 120,
  top: 60,
  width: 0,
  height: 0,
  right: 120,
  bottom: 60,
  x: 120,
  y: 60,
  ...over,
});

const open = (over: Partial<CopyPopoverState> = {}): CopyPopoverState => ({
  text: "zero downtime",
  anchorRect: anchor(),
  ...over,
});

const event = (over: Partial<CopyPopoverEvent> = {}): CopyPopoverEvent =>
  ({ kind: "copy-click", ...over }) as CopyPopoverEvent;

describe("nextCopyPopoverState", () => {
  describe("opening and replacing", () => {
    test("idle + selection-copy opens at the release point", () => {
      const next = nextCopyPopoverState(null, {
        kind: "selection-copy",
        text: "zero downtime",
        anchorRect: anchor(),
      });
      expect(next).toEqual(open({ text: "zero downtime", anchorRect: anchor() }));
    });

    test("open + a NEW selection-copy replaces (never stacks two Popovers)", () => {
      // A second drag-select while the first Popover is still open re-anchors
      // to the new release point and the new text. Stacking would put two
      // Copy buttons on screen; the reducer never allows it.
      const next = nextCopyPopoverState(open({ text: "first selection" }), {
        kind: "selection-copy",
        text: "second selection",
        anchorRect: anchor({ left: 300, top: 200 }),
      });
      expect(next).toEqual(
        open({ text: "second selection", anchorRect: anchor({ left: 300, top: 200 }) }),
      );
    });
  });

  describe("a copy click closes (after writing the clipboard)", () => {
    test("open + copy-click -> idle", () => {
      expect(nextCopyPopoverState(open(), event({ kind: "copy-click" }))).toBeNull();
    });
  });

  describe("every dismissal event closes an open Popover", () => {
    for (const kind of [
      "click-away",
      "scroll",
      "collapse",
      "geometry-change",
      "mode-toggle",
      "swap",
    ] as const) {
      test(`open + ${kind} -> idle`, () => {
        expect(nextCopyPopoverState(open(), { kind })).toBeNull();
      });
    }
  });

  describe("a closed Popover stays closed for any non-opening event", () => {
    for (const kind of [
      "copy-click",
      "click-away",
      "scroll",
      "collapse",
      "geometry-change",
      "mode-toggle",
      "swap",
    ] as const) {
      test(`idle + ${kind} -> idle`, () => {
        expect(nextCopyPopoverState(null, { kind })).toBeNull();
      });
    }
  });
});
