import { describe, expect, test } from "bun:test";
import { revealElement, revealOutlineActivation } from "../client/overlay/reveal.ts";
import { projectOutlineHeadings } from "../client/shared/artifact-outline.ts";

const fakeElement = (connected = true) => {
  const scrolls: ScrollIntoViewOptions[] = [];
  let focusCalls = 0;
  const element = {
    focus: () => {
      focusCalls += 1;
    },
    get isConnected() {
      return connected;
    },
    scrollIntoView: (options: ScrollIntoViewOptions) => scrolls.push(options),
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
        ensureStyles: () => effects.push("styles"),
        invalidate: () => effects.push("invalid"),
        markEmphasis: () => effects.push("mark"),
      }),
    ).toBe(true);
    expect(effects).toEqual(["styles", "clear", "mark"]);
    expect(target.scrolls).toEqual([{ behavior: "smooth", block: "center" }]);
    expect(target.focusCalls()).toBe(0);
  });

  test("reduced motion scrolls immediately while retaining resting emphasis", () => {
    const target = fakeElement();
    const emphasized: Element[] = [];
    revealElement(target.element, "reduced", {
      clearEmphasis: () => {},
      ensureStyles: () => {},
      invalidate: () => {},
      markEmphasis: (element) => {
        if (element) emphasized.push(element);
      },
    });
    expect(emphasized).toEqual([target.element]);
    expect(target.scrolls).toEqual([{ behavior: "instant", block: "center" }]);
    expect(target.focusCalls()).toBe(0);
  });

  test("a disconnected heading does not scroll and reports AO-002 invalidation", () => {
    const target = fakeElement(false);
    const health: unknown[] = [];
    expect(
      revealElement(target.element, "normal", {
        clearEmphasis: () => {},
        ensureStyles: () => {},
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
        { clearEmphasis: () => {}, ensureStyles: () => {}, invalidate: () => {} },
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
          ensureStyles: () => {},
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
