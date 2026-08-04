import { describe, expect, test } from "bun:test";
import {
  addedSectionsInView,
  enumerateSectionIds,
  findSection,
  isInViewport,
  type SectionDocument,
  type SectionEntry,
} from "../client/overlay/sections.ts";

const entry = (id: string, rect: { left: number; top?: number }, element?: unknown): SectionEntry =>
  ({
    element: (element ?? {}) as Element,
    id,
    rect: { height: 10, left: rect.left, top: rect.top ?? 0, width: 10 },
  }) as SectionEntry;

const doc = (sections: readonly SectionEntry[], viewport = { height: 800, width: 1200 }) =>
  ({
    sections: () => sections,
    viewport: () => viewport,
  }) as SectionDocument;

describe("overlay sections", () => {
  test("enumerates unique section ids in document order, dropping empties", () => {
    expect(
      enumerateSectionIds(
        doc([
          entry("a", { left: 0 }),
          entry("", { left: 0 }),
          entry("b", { left: 0 }),
          entry("a", { left: 0 }),
        ]),
      ),
    ).toEqual(["a", "b"]);
  });

  test("findSection returns the element for an id, undefined when missing", () => {
    const a = { tag: "a" } as unknown as Element;
    const d = doc([entry("a", { left: 0 }, a), entry("b", { left: 0 })]);
    expect(findSection(d, "a")).toBe(a);
    expect(findSection(d, "missing")).toBeUndefined();
  });

  test("isInViewport is true inside the viewport and false past each edge", () => {
    const viewport = { height: 800, width: 1200 };
    const rect = (
      overrides: Partial<{ left: number; top: number; width: number; height: number }>,
    ) => ({
      height: 10,
      left: 100,
      top: 100,
      width: 10,
      ...overrides,
    });
    expect(isInViewport(rect({}), viewport)).toBe(true);
    expect(isInViewport(rect({ top: -20 }), viewport)).toBe(false); // above
    expect(isInViewport(rect({ left: -20 }), viewport)).toBe(false); // left
    expect(isInViewport(rect({ top: 850 }), viewport)).toBe(false); // below
    expect(isInViewport(rect({ left: 1250 }), viewport)).toBe(false); // right
  });

  test("addedSectionsInView reports only added ids with their viewport flag, deduped", () => {
    const d = doc([
      entry("keep", { left: 100, top: 100 }),
      entry("new-visible", { left: 100, top: 100 }),
      entry("new-below", { left: 100, top: 900 }),
      entry("not-added", { left: 100, top: 100 }),
    ]);
    expect(addedSectionsInView(d, new Set(["new-visible", "new-below", "absent"]))).toEqual([
      { id: "new-visible", inViewport: true },
      { id: "new-below", inViewport: false },
    ]);
  });
});
