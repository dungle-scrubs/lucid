import { describe, expect, test } from "bun:test";
import { revealElement, revealOutlineActivation } from "../client/overlay/reveal.ts";
import { projectOutlineHeadings } from "../client/shared/artifact-outline.ts";

/** The heading sits 200px down a view already scrolled 500px, so the reveal
 *  target is a number no other combination of the two could produce. */
const HEADING_VIEWPORT_TOP = 200;
const VIEW_SCROLL_Y = 500;

const fakeElement = (connected = true) => {
  const scrolls: ScrollToOptions[] = [];
  let focusCalls = 0;
  const element = {
    focus: () => {
      focusCalls += 1;
    },
    getBoundingClientRect: () => ({ top: HEADING_VIEWPORT_TOP }) as DOMRect,
    get isConnected() {
      return connected;
    },
    ownerDocument: {
      defaultView: {
        scrollTo: (options: ScrollToOptions) => scrolls.push(options),
        scrollY: VIEW_SCROLL_Y,
      },
    },
    scrollIntoView: () => {
      throw new Error("reveal must scroll the view, never the element");
    },
  } as unknown as Element;
  return { element, focusCalls: () => focusCalls, scrolls };
};

describe("outline element reveal", () => {
  test("normal motion scrolls smoothly and applies the shared transient emphasis", () => {
    const target = fakeElement();
    const effects: string[] = [];
    expect(
      revealElement(target.element, "normal", {
        clearEmphasis: () => effects.push("clear"),
        invalidate: () => effects.push("invalid"),
        markEmphasis: () => effects.push("mark"),
      }),
    ).toBe(true);
    expect(effects).toEqual(["clear", "mark"]);
    // Top-aligned, not centred: the heading is the top of what the reader came
    // for, so the section opens below it rather than being cut in half. The
    // 72px inset keeps it clear of the edge so an eyebrow above it survives.
    expect(target.scrolls).toEqual([{ behavior: "smooth", top: 200 + 500 - 72 }]);
    expect(target.focusCalls()).toBe(0);
  });

  test("reduced motion scrolls immediately while retaining resting emphasis", () => {
    const target = fakeElement();
    const emphasized: Element[] = [];
    revealElement(target.element, "reduced", {
      clearEmphasis: () => {},
      invalidate: () => {},
      markEmphasis: (element) => {
        if (element) emphasized.push(element);
      },
    });
    expect(emphasized).toEqual([target.element]);
    expect(target.scrolls).toEqual([{ behavior: "instant", top: 200 + 500 - 72 }]);
    expect(target.focusCalls()).toBe(0);
  });

  test("a disconnected heading does not scroll and reports AO-002 invalidation", () => {
    const target = fakeElement(false);
    const health: unknown[] = [];
    expect(
      revealElement(target.element, "normal", {
        clearEmphasis: () => {},
        invalidate: (record) => health.push(record),
      }),
    ).toBe(false);
    expect(target.scrolls).toEqual([]);
    expect(health).toEqual([
      { code: "AO-002", generation: 0, occurrenceCount: 1, reason: "disconnected-heading" },
    ]);
  });

  test("a generation-matched outline key reaches the same element reveal seam", () => {
    const target = fakeElement();
    const projection = projectOutlineHeadings(7, [
      { key: "one", text: "One" },
      { key: "two", text: "Two" },
    ]);
    expect(
      revealOutlineActivation(
        projection,
        { generation: 7, key: "two" },
        (key) => (key === "two" ? target.element : null),
        "normal",
        { clearEmphasis: () => {} },
      ),
    ).toBe(true);
    expect(target.scrolls).toHaveLength(1);
  });

  test("a stale generation does not resolve or scroll and reports AO-002", () => {
    const target = fakeElement();
    const health: unknown[] = [];
    const projection = projectOutlineHeadings(7, [
      { key: "one", text: "One" },
      { key: "two", text: "Two" },
    ]);
    expect(
      revealOutlineActivation(
        projection,
        { generation: 6, key: "two" },
        () => target.element,
        "normal",
        {
          clearEmphasis: () => {},
          invalidate: (record) => health.push(record),
        },
      ),
    ).toBe(false);
    expect(target.scrolls).toEqual([]);
    expect(health).toEqual([
      { code: "AO-002", generation: 7, occurrenceCount: 1, reason: "stale-generation" },
    ]);
  });
});
