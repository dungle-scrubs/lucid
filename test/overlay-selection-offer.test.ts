import { describe, expect, test } from "bun:test";
import {
  shouldOfferSelectionCopy,
  type SelectionOfferInput,
} from "../client/overlay/selection-offer.ts";

/**
 * The decision that pins copy as mode-independent.
 *
 * `shouldOfferSelectionCopy` answers ONE question: on mouseup, given the
 * targeting mode and whether the selection collapsed, should the overlay post
 * a `selection-copy`? The whole point of pulling it out (D-004) is that the
 * interesting fact - copying is offered in BOTH targeting modes - is a TABLE
 * a browser is the wrong instrument for measuring, and pinning it here means a
 * future re-introduction of the `showTargets` gate (the pre-Popover overlay
 * gated ALL selection handling on `showTargets`) fails this unit test rather
 * than silently regressing read-mode copy. What stays in the overlay wiring
 * (and in e2e) is that the mouseup really fires and the message really lands.
 */

const input = (over: Partial<SelectionOfferInput> = {}): SelectionOfferInput => ({
  showTargets: true,
  selectionCollapsed: false,
  ...over,
});

describe("shouldOfferSelectionCopy", () => {
  describe("a non-collapsed selection is offered a copy in BOTH modes", () => {
    test("targeting ON (showTargets true): a real drag selection offers a copy", () => {
      // The case the pre-Popover overlay already handled: a drag selection in
      // targeting mode. The Popover must coexist with the annotation pick.
      expect(
        shouldOfferSelectionCopy(input({ showTargets: true, selectionCollapsed: false })),
      ).toBe(true);
    });

    test("targeting OFF (showTargets false): a read-mode selection offers a copy", () => {
      // THE spec's heart. Read mode used to gate ALL selection handling on
      // `showTargets` and so offered no copy path at all. Copying is a read
      // action; this pins that the gate is gone. A future `if (!showTargets)
      // return false` regresses exactly this.
      expect(
        shouldOfferSelectionCopy(input({ showTargets: false, selectionCollapsed: false })),
      ).toBe(true);
    });
  });

  describe("a collapsed selection (a bare click) offers nothing in BOTH modes", () => {
    test("targeting ON: a bare click does not open a Popover", () => {
      expect(shouldOfferSelectionCopy(input({ showTargets: true, selectionCollapsed: true }))).toBe(
        false,
      );
    });

    test("targeting OFF: a bare click does not open a Popover", () => {
      expect(
        shouldOfferSelectionCopy(input({ showTargets: false, selectionCollapsed: true })),
      ).toBe(false);
    });
  });

  test("mode never changes the result for the same selection state", () => {
    // The exhaustive pair: every (mode x collapse) combination where only the
    // collapse matters. This is the regression net for the mode gate.
    for (const showTargets of [true, false]) {
      expect(shouldOfferSelectionCopy(input({ showTargets, selectionCollapsed: false }))).toBe(
        true,
      );
      expect(shouldOfferSelectionCopy(input({ showTargets, selectionCollapsed: true }))).toBe(
        false,
      );
    }
  });
});
