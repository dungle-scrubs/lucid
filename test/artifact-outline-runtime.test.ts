import { describe, expect, test } from "bun:test";
import {
  type ArtifactOutlineGeometry,
  ArtifactOutlineRuntime,
  type OutlineRuntimeElement,
} from "../client/overlay/artifact-outline-runtime.ts";
import type { OutlineRuntimePublication } from "../client/shared/artifact-outline.ts";
import { validateOutlineSnapshot } from "../client/shared/artifact-outline.ts";

interface FakeElement extends OutlineRuntimeElement {
  readonly children: FakeElement[];
  readonly id: string;
  parent: FakeElement | null;
}

const node = (
  id: string,
  options: Partial<Omit<FakeElement, "children" | "id" | "parent">> = {},
): FakeElement => ({
  ariaHidden: false,
  activeMotion: false,
  children: [],
  clientHeight: 20,
  clientWidth: 100,
  connected: true,
  hasBox: true,
  hidden: false,
  id,
  inert: false,
  lightDom: true,
  parent: null,
  rect: { bottom: 120, left: 100, right: 700, top: 100 },
  scrollHeight: 20,
  scrollWidth: 100,
  style: {
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
  },
  tagName: "H2",
  text: id,
  textComplete: true,
  textNodesExamined: id === "" ? 0 : 1,
  ...options,
});

const append = (parent: FakeElement, child: FakeElement): FakeElement => {
  parent.children.push(child);
  child.parent = parent;
  return child;
};

const geometry = (
  roots: readonly FakeElement[],
  options: {
    readonly completeTraversal?: boolean;
    readonly pseudoContent?: (element: FakeElement) => {
      readonly after: string;
      readonly before: string;
    };
    readonly settled?: boolean;
    readonly proofRealmTrusted?: boolean;
    readonly styleRealmTrusted?: boolean;
    readonly width?: number;
  } = {},
): ArtifactOutlineGeometry<FakeElement> => {
  const elements: FakeElement[] = [];
  const visit = (element: FakeElement): void => {
    elements.push(element);
    for (const child of element.children) visit(child);
  };
  for (const root of roots) visit(root);
  return {
    allElements: () => elements,
    completeTraversal: () => options.completeTraversal ?? true,
    headingCandidates: () => elements.filter((element) => element.tagName === "H2"),
    isSettled: () => options.settled ?? true,
    parentElement: (element) => element.parent,
    pseudoContent: options.pseudoContent ?? (() => ({ after: "none", before: "none" })),
    proofRealmTrusted: () => options.proofRealmTrusted ?? true,
    styleRealmTrusted: () => options.styleRealmTrusted ?? true,
    viewport: () => ({
      clientWidth: options.width ?? 1_600,
      height: 900,
      width: options.width ?? 1_600,
    }),
  };
};

class ManualScheduler {
  readonly quietTasks: (() => void)[] = [];
  readonly frameTasks: (() => void)[] = [];

  scheduleQuiet = (_delayMs: number, task: () => void): (() => void) => {
    let cancelled = false;
    this.quietTasks.push(() => {
      if (!cancelled) task();
    });
    return () => {
      cancelled = true;
    };
  };

  scheduleFrame = (task: () => void): (() => void) => {
    let cancelled = false;
    this.frameTasks.push(() => {
      if (!cancelled) task();
    });
    return () => {
      cancelled = true;
    };
  };

  flushQuiet(): void {
    for (const task of this.quietTasks.splice(0)) task();
  }
}

const request = {
  generation: 1,
  preferredWidth: 240,
  safeInsets: { bottom: 24, right: 16, top: 96 },
} as const;

const harness = (
  roots: readonly FakeElement[],
  options: {
    readonly geometry?: ArtifactOutlineGeometry<FakeElement>;
    readonly now?: () => number;
  } = {},
) => {
  const publications: OutlineRuntimePublication[] = [];
  const scheduler = new ManualScheduler();
  const runtime = new ArtifactOutlineRuntime({
    geometry: options.geometry ?? geometry(roots),
    now: options.now ?? (() => 0),
    publish: (publication) => publications.push(publication),
    scheduleFrame: scheduler.scheduleFrame,
    scheduleQuiet: scheduler.scheduleQuiet,
  });
  return { publications, runtime, scheduler };
};

describe("ArtifactOutlineRuntime eligibility and complete extraction", () => {
  test("publishes connected visible non-empty light-DOM H2s in document order", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("  First\n section "));
    append(main, node("Second section"));
    const { publications, runtime, scheduler } = harness([main]);

    runtime.requestLayout(request);
    scheduler.flushQuiet();

    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      type: "snapshot",
      availability: "complete",
      headings: [{ label: "First section" }, { label: "Second section" }],
    });
    expect(validateOutlineSnapshot(publications[0], { trustedGeometry: true })).not.toBeNull();
  });

  test("one ordinary section is absent without reporting a geometry failure", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("Only section"));
    const { publications, runtime, scheduler } = harness([main]);

    runtime.requestLayout(request);
    scheduler.flushQuiet();

    expect(publications[0]).toMatchObject({ availability: "absent", headings: [] });
    expect(publications[0]).not.toHaveProperty("health");
  });

  test("excludes hidden ancestry, no-box, disconnected, empty, shadow, and nested-scroll headings", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("Eligible one"));
    append(main, node("Eligible two"));
    for (const excluded of [
      node("hidden", { hidden: true }),
      node("inert", { inert: true }),
      node("aria hidden", { ariaHidden: true }),
      node("display none", { style: { ...node("style").style, display: "none" } }),
      node("visibility hidden", {
        style: { ...node("style").style, visibility: "hidden" },
      }),
      node("visibility collapse", {
        style: { ...node("style").style, visibility: "collapse" },
      }),
      node("no box", { hasBox: false }),
      node("disconnected", { connected: false }),
      node("shadow", { lightDom: false }),
      node("   "),
    ]) {
      append(main, excluded);
    }
    const hiddenParent = append(main, node("hidden parent", { hidden: true, tagName: "DIV" }));
    append(hiddenParent, node("hidden descendant"));
    const scroller = append(
      main,
      node("scroller", {
        clientHeight: 100,
        scrollHeight: 400,
        style: { ...node("style").style, overflowY: "auto" },
        tagName: "DIV",
      }),
    );
    append(scroller, node("nested scroll heading"));
    const { publications, runtime, scheduler } = harness([main]);

    runtime.requestLayout(request);
    scheduler.flushQuiet();

    expect(publications[0]).toMatchObject({
      availability: "complete",
      headings: [{ label: "Eligible one" }, { label: "Eligible two" }],
    });
  });

  test("publishes no prefix when projection bounds reject the complete heading set", () => {
    const main = node("main", { tagName: "MAIN" });
    for (let index = 0; index < 65; index += 1) append(main, node(`Heading ${index}`));
    const { publications, runtime, scheduler } = harness([main]);

    runtime.requestLayout(request);
    scheduler.flushQuiet();

    expect(publications[0]).toMatchObject({
      availability: "absent",
      headings: [],
      health: { code: "AO-001", reason: "heading-count" },
    });
  });

  test("stops reading heading labels when the sixty-fifth eligible heading decides absence", () => {
    const main = node("main", { tagName: "MAIN" });
    let textReads = 0;
    for (let index = 0; index < 200; index += 1) {
      const heading = node(`Heading ${index}`);
      const label = heading.text;
      Object.defineProperty(heading, "text", {
        get: () => {
          textReads += 1;
          return label;
        },
      });
      append(main, heading);
    }
    const { publications, runtime, scheduler } = harness([main]);

    runtime.requestLayout(request);
    scheduler.flushQuiet();

    expect(publications[0]).toMatchObject({
      availability: "absent",
      health: { code: "AO-001", reason: "heading-count" },
    });
    expect(textReads).toBe(65 * 2);
  });

  test("revision rebuilds ephemeral keys and advances generation", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    let now = 0;
    const { publications, runtime, scheduler } = harness([main], { now: () => now });
    runtime.requestLayout(request);
    scheduler.flushQuiet();
    const first = publications[0];
    expect(first?.type).toBe("snapshot");
    if (first?.type !== "snapshot") throw new Error("snapshot missing");

    runtime.revise();
    expect(publications.map(({ type }) => type)).toEqual(["snapshot", "invalidated"]);
    const invalidations: string[] = [];
    expect(
      runtime.activate(
        { generation: first.generation, key: first.headings[0]?.key ?? "missing" },
        "reduced",
        {
          clearEmphasis: () => undefined,
          ensureStyles: () => undefined,
          invalidate: ({ reason }) => invalidations.push(reason),
        },
      ),
    ).toBe(false);
    expect(invalidations).toEqual(["stale-generation"]);
    now = 250;
    scheduler.flushQuiet();
    const second = publications.at(-1);
    expect(second?.type).toBe("snapshot");
    if (second?.type !== "snapshot") throw new Error("replacement snapshot missing");
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.headings.map(({ key }) => key)).not.toEqual(first.headings.map(({ key }) => key));
  });

  test("AO-002 withdrawal publishes one correlated diagnostic", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const { publications, runtime, scheduler } = harness([main]);
    runtime.requestLayout(request);
    scheduler.flushQuiet();
    const snapshot = publications[0];
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot") throw new Error("snapshot missing");

    runtime.invalidateWithHealth({
      code: "AO-002",
      generation: snapshot.generation,
      occurrenceCount: 1,
      reason: "disconnected-heading",
    });

    expect(publications.slice(1)).toEqual([
      {
        generation: snapshot.generation,
        health: {
          code: "AO-002",
          generation: snapshot.generation,
          occurrenceCount: 1,
          reason: "disconnected-heading",
        },
        type: "invalidated",
      },
    ]);
    expect(runtime.debugInfo()).toMatchObject({ healthCode: "AO-002", headingCount: 0 });
  });

  test("layout-only reprojection preserves native heading identity across fresh wrappers", () => {
    const one = {} as Element;
    const two = {} as Element;
    const three = {} as Element;
    let headingOrder = [
      { id: "One", nativeElement: one },
      { id: "Two", nativeElement: two },
    ];
    let current: FakeElement[] = [];
    const dynamicGeometry: ArtifactOutlineGeometry<FakeElement> = {
      allElements: () => current,
      completeTraversal: () => {
        const main = node("main", { tagName: "MAIN" });
        current = [
          main,
          ...headingOrder.map(({ id, nativeElement }) => append(main, node(id, { nativeElement }))),
        ];
        return true;
      },
      headingCandidates: () => current.filter(({ tagName }) => tagName === "H2"),
      isSettled: () => true,
      parentElement: (element) => element.parent,
      pseudoContent: () => ({ after: "none", before: "none" }),
      styleRealmTrusted: () => true,
      viewport: () => ({ clientWidth: 1_600, height: 900, width: 1_600 }),
    };
    let now = 0;
    const { publications, runtime, scheduler } = harness([], {
      geometry: dynamicGeometry,
      now: () => now,
    });
    runtime.requestLayout(request);
    scheduler.flushQuiet();
    const first = publications.at(-1);
    expect(first?.type).toBe("snapshot");
    if (first?.type !== "snapshot") throw new Error("snapshot missing");
    const firstKeys = Object.fromEntries(first.headings.map(({ key, label }) => [label, key]));

    headingOrder = [
      { id: "Three", nativeElement: three },
      { id: "Two", nativeElement: two },
      { id: "One", nativeElement: one },
    ];
    runtime.requestLayout({ ...request, generation: 2 });
    now = 250;
    scheduler.flushQuiet();
    const second = publications.at(-1);
    expect(second?.type).toBe("snapshot");
    if (second?.type !== "snapshot") throw new Error("replacement snapshot missing");
    expect(second.generation).toBeGreaterThan(first.generation);
    const secondKeys = Object.fromEntries(second.headings.map(({ key, label }) => [label, key]));
    expect(secondKeys.One).toBe(firstKeys.One);
    expect(secondKeys.Two).toBe(firstKeys.Two);
    expect(secondKeys.Three).not.toBe(firstKeys.One);
    expect(secondKeys.Three).not.toBe(firstKeys.Two);
    const twoKey = firstKeys.Two;
    const threeKey = secondKeys.Three;
    if (twoKey === undefined || threeKey === undefined) throw new Error("stable keys missing");

    headingOrder = [
      { id: "Two", nativeElement: two },
      { id: "Three", nativeElement: three },
    ];
    runtime.requestLayout({ ...request, generation: 3 });
    now = 500;
    scheduler.flushQuiet();
    const third = publications.at(-1);
    expect(third?.type).toBe("snapshot");
    if (third?.type !== "snapshot") throw new Error("second replacement snapshot missing");
    expect(Object.fromEntries(third.headings.map(({ key, label }) => [label, key]))).toEqual({
      Three: threeKey,
      Two: twoKey,
    });
  });
});

describe("ArtifactOutlineRuntime conservative proof", () => {
  const complete = (
    roots: readonly FakeElement[],
    customGeometry?: ArtifactOutlineGeometry<FakeElement>,
  ) => {
    const result = harness(roots, customGeometry ? { geometry: customGeometry } : undefined);
    result.runtime.requestLayout(request);
    result.scheduler.flushQuiet();
    return result.publications[0];
  };

  test("pins a centered artifact only after a complete empty candidate rectangle", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    expect(complete([main])).toMatchObject({
      availability: "complete",
      proof: { complete: true, reason: "complete-unused-rectangle" },
    });
  });

  test("reports actual nine-pixel clearance so hysteresis can retain but not enter", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const result = harness([main]);
    result.runtime.requestLayout({
      ...request,
      safeInsets: { ...request.safeInsets, right: 9 },
    });
    result.scheduler.flushQuiet();
    expect(result.publications[0]).toMatchObject({
      proof: { clearancePx: 9, complete: true },
    });
  });

  test("semantic hiding never conceals visible right-edge paint from proof", () => {
    for (const semantic of [{ ariaHidden: true }, { inert: true }, { hidden: true }]) {
      const main = node("main", { tagName: "MAIN" });
      append(main, node("One"));
      append(main, node("Two"));
      const hazard = node("semantic hazard", {
        rect: { bottom: 300, left: 1_320, right: 1_400, top: 100 },
        tagName: "ASIDE",
        ...semantic,
      });
      expect(complete([main, hazard])).toMatchObject({
        proof: { complete: false, reason: "box-intersection" },
      });
    }
  });

  test("full-width and uncertain positioned paint fail closed", () => {
    for (const style of [
      {},
      { position: "fixed" },
      { position: "absolute" },
      { position: "sticky" },
      { transform: "translateX(1px)" },
    ]) {
      const main = node("main", {
        rect: { bottom: 880, left: 0, right: 1_590, top: 0 },
        style: { ...node("style").style, ...style },
        tagName: "MAIN",
      });
      append(main, node("One"));
      append(main, node("Two"));
      expect(complete([main])).toMatchObject({ proof: { complete: false } });
    }
  });

  test("a same-origin style realm makes pinned proof unavailable", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const { publications, runtime, scheduler } = harness([main], {
      geometry: geometry([main], { styleRealmTrusted: false }),
    });
    runtime.requestLayout(request);
    scheduler.flushQuiet();
    expect(publications[0]).toMatchObject({
      availability: "complete",
      proof: { complete: false, reason: "untrusted-style-realm" },
    });
  });

  test("proof intrinsic tampering makes projection unavailable before traversal", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const { publications, runtime, scheduler } = harness([main], {
      geometry: geometry([main], { proofRealmTrusted: false }),
    });
    runtime.requestLayout(request);
    scheduler.flushQuiet();
    expect(publications).toEqual([]);
    expect(runtime.debugInfo()).toMatchObject({
      proofComplete: false,
      proofReason: "untrusted-proof-realm",
    });
  });

  test("nested scrolling, overflow, shadows, clipping, pseudo-content, and unsettled layout fail closed", () => {
    const cases: Array<{
      readonly element?: Partial<FakeElement>;
      readonly pseudo?: string;
      readonly settled?: boolean;
      readonly reason: string;
    }> = [
      {
        element: {
          clientHeight: 100,
          scrollHeight: 400,
          style: { ...node("style").style, overflowY: "auto" },
        },
        reason: "nested-vertical-scroller",
      },
      {
        element: {
          clientWidth: 10,
          scrollWidth: 300,
          style: { ...node("style").style, overflowX: "visible" },
        },
        reason: "visible-horizontal-overflow",
      },
      {
        element: { style: { ...node("style").style, boxShadow: "20px 0 20px black" } },
        reason: "unbounded-shadow-near-candidate",
      },
      {
        element: { style: { ...node("style").style, filter: "drop-shadow(400px 0 black)" } },
        reason: "unbounded-shadow-near-candidate",
      },
      {
        element: { style: { ...node("style").style, textShadow: "400px 0 black" } },
        reason: "unbounded-shadow-near-candidate",
      },
      {
        element: {
          style: { ...node("style").style, outlineStyle: "solid", outlineWidth: "400px" },
        },
        reason: "unbounded-shadow-near-candidate",
      },
      { element: { activeMotion: true }, reason: "dynamic-paint" },
      {
        element: { style: { ...node("style").style, clipPath: "inset(1px)" } },
        reason: "clipped-paint-near-candidate",
      },
      {
        element: { rect: { bottom: 200, left: 100, right: 200, top: 100 } },
        pseudo: "fixed artifact note",
        reason: "pseudo-content-near-candidate",
      },
      { reason: "layout-unsettled", settled: false },
    ];
    for (const fixture of cases) {
      const main = node("main", { tagName: "MAIN" });
      append(main, node("One"));
      append(main, node("Two"));
      const hazard = node("hazard", {
        rect: { bottom: 200, left: 1_300, right: 1_340, top: 100 },
        tagName: "ASIDE",
        ...fixture.element,
      });
      const custom = geometry([main, hazard], {
        pseudoContent: () => ({ after: fixture.pseudo ?? "none", before: "none" }),
        settled: fixture.settled,
      });
      const publication = complete([main, hazard], custom);
      expect(publication).toMatchObject({
        proof: { complete: false, reason: fixture.reason },
      });
      if (fixture.reason === "layout-unsettled") {
        expect(publication).toMatchObject({ availability: "absent", headings: [] });
      }
    }
  });

  test("item and time budget exhaustion fail safe without a partial heading prefix", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    for (let index = 0; index < 2_100; index += 1) {
      append(main, node(`span-${index}`, { tagName: "SPAN" }));
    }
    expect(complete([main])).toMatchObject({
      availability: "complete",
      headings: [{ label: "One" }, { label: "Two" }],
      health: { code: "AO-004" },
      proof: { complete: false, reason: "work-budget-exhausted" },
    });

    let clock = 0;
    const timed = harness([main], { now: () => clock++ });
    timed.runtime.requestLayout(request);
    timed.scheduler.flushQuiet();
    expect(timed.publications[0]).toMatchObject({
      availability: "absent",
      headings: [],
      health: { code: "AO-004", reason: "work-budget-exhausted" },
      proof: { complete: false, reason: "work-budget-exhausted" },
    });
  });

  test("an incomplete bounded traversal publishes no partial heading set", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    expect(complete([main], geometry([main], { completeTraversal: false }))).toMatchObject({
      availability: "absent",
      headings: [],
      health: { code: "AO-004", reason: "item-budget-exhausted" },
    });
  });

  test("an incomplete bounded text-node walk publishes no heading prefix", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One", { textComplete: false }));
    append(main, node("Two"));
    expect(complete([main])).toMatchObject({
      availability: "absent",
      headings: [],
      health: { code: "AO-004", reason: "work-budget-exhausted" },
    });
  });
});

describe("ArtifactOutlineRuntime scheduling, cancellation, and diagnostics", () => {
  test("every delayed callback rechecks proof trust before doing work", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    let trusted = true;
    let now = 0;
    const guardedGeometry = {
      ...geometry([main]),
      proofRealmTrusted: () => trusted,
    };

    const quiet = harness([main], { geometry: guardedGeometry, now: () => now });
    quiet.runtime.requestLayout(request);
    trusted = false;
    quiet.scheduler.flushQuiet();
    expect(quiet.publications).toEqual([]);
    expect(quiet.runtime.debugInfo()).toMatchObject({
      proofReason: "untrusted-proof-realm",
      taskCount: 0,
    });

    trusted = true;
    const frame = harness([main], { geometry: guardedGeometry, now: () => now });
    frame.runtime.requestLayout(request);
    frame.scheduler.flushQuiet();
    frame.runtime.trackActive();
    trusted = false;
    for (const task of frame.scheduler.frameTasks.splice(0)) task();
    expect(frame.runtime.debugInfo()).toMatchObject({
      pendingFrame: false,
      proofReason: "untrusted-proof-realm",
    });

    trusted = true;
    const snapshot = harness([main], { geometry: guardedGeometry, now: () => now });
    snapshot.runtime.requestLayout(request);
    snapshot.scheduler.flushQuiet();
    now = 10;
    snapshot.runtime.revise();
    snapshot.scheduler.flushQuiet();
    expect(snapshot.scheduler.quietTasks).not.toHaveLength(0);
    trusted = false;
    snapshot.scheduler.flushQuiet();
    expect(snapshot.publications.filter(({ type }) => type === "snapshot")).toHaveLength(1);
    expect(snapshot.runtime.debugInfo()).toMatchObject({
      proofReason: "untrusted-proof-realm",
    });
  });

  test("a replacement layout request withdraws the published proof before quiet work", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const { publications, runtime, scheduler } = harness([main]);
    runtime.requestLayout(request);
    scheduler.flushQuiet();

    runtime.requestLayout({
      ...request,
      generation: 2,
      safeInsets: { ...request.safeInsets, right: 40 },
    });

    expect(publications.map(({ type }) => type)).toEqual(["snapshot", "invalidated"]);
    expect(runtime.debugInfo()).toMatchObject({ headingCount: 0, proofComplete: false });
  });

  test("stays dormant until requested and coalesces 200 invalidations into one quiet task", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const { publications, runtime, scheduler } = harness([main]);
    for (let index = 0; index < 200; index += 1) runtime.invalidate(`before-${index}`);
    scheduler.flushQuiet();
    expect(publications).toEqual([]);
    expect(runtime.debugInfo()).toMatchObject({ dormant: true, taskCount: 0 });

    runtime.requestLayout(request);
    for (let index = 0; index < 200; index += 1) runtime.invalidate(`burst-${index}`);
    expect(publications).toEqual([]);
    scheduler.flushQuiet();
    expect(publications).toHaveLength(1);
    expect(runtime.debugInfo()).toMatchObject({ pendingQuietTask: false, taskCount: 1 });
  });

  test("continuous mutation remains absent and disconnect suppresses stale work", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const { publications, runtime, scheduler } = harness([main]);
    runtime.requestLayout(request);
    runtime.invalidate("still-mutating");
    expect(publications).toEqual([]);
    runtime.disconnect();
    scheduler.flushQuiet();
    expect(publications).toEqual([]);
    expect(runtime.debugInfo()).toMatchObject({ connected: false, pendingQuietTask: false });
  });

  test("a transient work-budget miss gets one quiet retry and recovers", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    const base = geometry([main]);
    let traversals = 0;
    let now = 0;
    const result = harness([main], {
      geometry: {
        ...base,
        completeTraversal: () => {
          traversals += 1;
          return traversals > 1;
        },
      },
      now: () => now,
    });

    result.runtime.requestLayout(request);
    result.scheduler.flushQuiet();
    expect(result.publications.at(-1)).toMatchObject({
      availability: "absent",
      health: { code: "AO-004", reason: "item-budget-exhausted" },
    });
    expect(result.runtime.debugInfo()).toMatchObject({ pendingQuietTask: true, taskCount: 1 });

    now += 250;
    result.scheduler.flushQuiet();
    expect(result.publications.at(-1)).toMatchObject({ availability: "complete" });
    expect(result.runtime.debugInfo()).toMatchObject({ pendingQuietTask: false, taskCount: 2 });
    result.scheduler.flushQuiet();
    expect(result.runtime.debugInfo()).toMatchObject({ pendingQuietTask: false, taskCount: 2 });
  });

  test("persistent budget failure gets one retry per invalidation and disconnect cancels it", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    let now = 0;
    const alwaysExhausted = {
      ...geometry([main]),
      completeTraversal: () => false,
    };
    const result = harness([main], { geometry: alwaysExhausted, now: () => now });

    result.runtime.requestLayout(request);
    result.scheduler.flushQuiet();
    now += 250;
    result.scheduler.flushQuiet();
    result.scheduler.flushQuiet();
    expect(result.runtime.debugInfo()).toMatchObject({ pendingQuietTask: false, taskCount: 2 });

    result.runtime.invalidate("fresh-external-change");
    now += 250;
    result.scheduler.flushQuiet();
    expect(result.runtime.debugInfo()).toMatchObject({ pendingQuietTask: true, taskCount: 3 });
    now += 250;
    result.scheduler.flushQuiet();
    result.scheduler.flushQuiet();
    expect(result.runtime.debugInfo()).toMatchObject({ pendingQuietTask: false, taskCount: 4 });

    const cancelled = harness([main], { geometry: alwaysExhausted, now: () => now });
    cancelled.runtime.requestLayout(request);
    cancelled.scheduler.flushQuiet();
    expect(cancelled.runtime.debugInfo()).toMatchObject({ pendingQuietTask: true, taskCount: 1 });
    cancelled.runtime.disconnect();
    now += 250;
    cancelled.scheduler.flushQuiet();
    expect(cancelled.runtime.debugInfo()).toMatchObject({
      connected: false,
      pendingQuietTask: false,
      taskCount: 1,
    });
  });

  test("sustained just-quiet mutations bound projection work and retain one trailing rebuild", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    let now = 0;
    const { publications, runtime, scheduler } = harness([main], { now: () => now });
    runtime.requestLayout(request);
    scheduler.flushQuiet();

    for (let index = 0; index < 20; index += 1) {
      now += 41;
      runtime.invalidate(`sustained-${index}`);
      scheduler.flushQuiet();
    }

    expect(runtime.debugInfo().taskCount).toBeLessThanOrEqual(4);
    expect(runtime.debugInfo()).toMatchObject({ headingCount: 0, pendingQuietTask: true });
    now += 250;
    scheduler.flushQuiet();
    expect(runtime.debugInfo()).toMatchObject({ headingCount: 2, pendingQuietTask: false });
    expect(runtime.debugInfo().taskCount).toBeLessThanOrEqual(5);
    expect(publications.at(-1)).toMatchObject({ availability: "complete", type: "snapshot" });
  });

  test("sustained layout requests bound projection work and retain one trailing rebuild", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("One"));
    append(main, node("Two"));
    let now = 0;
    const { publications, runtime, scheduler } = harness([main], { now: () => now });
    runtime.requestLayout(request);
    scheduler.flushQuiet();

    for (let index = 0; index < 20; index += 1) {
      now += 41;
      runtime.requestLayout({
        ...request,
        generation: index + 2,
        safeInsets: { ...request.safeInsets, right: index + 17 },
      });
      scheduler.flushQuiet();
    }

    expect(runtime.debugInfo().taskCount).toBeLessThanOrEqual(4);
    expect(runtime.debugInfo()).toMatchObject({ headingCount: 0, pendingQuietTask: true });
    expect(publications.filter(({ type }) => type === "invalidated").length).toBeLessThanOrEqual(4);
    now += 250;
    scheduler.flushQuiet();
    expect(runtime.debugInfo()).toMatchObject({ headingCount: 2, pendingQuietTask: false });
    expect(runtime.debugInfo().taskCount).toBeLessThanOrEqual(5);
    expect(publications.at(-1)).toMatchObject({ availability: "complete", type: "snapshot" });
  });

  test("active tracking is animation-frame bounded and debugInfo contains no labels", () => {
    const main = node("main", { tagName: "MAIN" });
    const one = append(
      main,
      node("Sensitive first label", { rect: { bottom: 20, left: 100, right: 700, top: 0 } }),
    );
    append(
      main,
      node("Sensitive second label", { rect: { bottom: 140, left: 100, right: 700, top: 120 } }),
    );
    const { publications, runtime, scheduler } = harness([main]);
    runtime.requestLayout(request);
    scheduler.flushQuiet();
    (one as { rect: OutlineRuntimeElement["rect"] }).rect = {
      bottom: -100,
      left: 100,
      right: 700,
      top: -120,
    };
    runtime.trackActive();
    runtime.trackActive();
    expect(scheduler.frameTasks).toHaveLength(1);
    for (const task of scheduler.frameTasks.splice(0)) task();
    expect(publications.filter(({ type }) => type === "active").length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(runtime.debugInfo())).not.toContain("Sensitive");
  });

  test("active-key publications are capped at ten per second", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("First", { rect: { bottom: 20, left: 100, right: 700, top: 0 } }));
    const second = append(
      main,
      node("Second", { rect: { bottom: 140, left: 100, right: 700, top: 120 } }),
    );
    let now = 0;
    const { publications, runtime, scheduler } = harness([main], { now: () => now });
    runtime.requestLayout(request);
    scheduler.flushQuiet();

    for (let index = 0; index < 11; index += 1) {
      (second as { rect: OutlineRuntimeElement["rect"] }).rect = {
        bottom: index % 2 === 0 ? 20 : 140,
        left: 100,
        right: 700,
        top: index % 2 === 0 ? 0 : 120,
      };
      runtime.trackActive();
      for (const task of scheduler.frameTasks.splice(0)) task();
      now = Math.min(now + 100, 999);
    }

    expect(publications.filter(({ type }) => type === "active")).toHaveLength(10);
  });

  test("unchanged samples do not suppress a later active heading change", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("First", { rect: { bottom: 20, left: 100, right: 700, top: 0 } }));
    const second = append(
      main,
      node("Second", { rect: { bottom: 140, left: 100, right: 700, top: 120 } }),
    );
    let now = 0;
    const { publications, runtime, scheduler } = harness([main], { now: () => now });
    runtime.requestLayout(request);
    scheduler.flushQuiet();

    for (let index = 0; index < 10; index += 1) {
      runtime.trackActive();
      for (const task of scheduler.frameTasks.splice(0)) task();
      now += 100;
    }
    (second as { rect: OutlineRuntimeElement["rect"] }).rect = {
      bottom: 20,
      left: 100,
      right: 700,
      top: 0,
    };
    runtime.trackActive();
    for (const task of scheduler.frameTasks.splice(0)) task();

    expect(publications.filter(({ type }) => type === "active")).toHaveLength(1);
  });

  test("a change inside the sampling interval publishes from the trailing sample", () => {
    const main = node("main", { tagName: "MAIN" });
    append(main, node("First", { rect: { bottom: 20, left: 100, right: 700, top: 0 } }));
    const second = append(
      main,
      node("Second", { rect: { bottom: 140, left: 100, right: 700, top: 120 } }),
    );
    let now = 0;
    const { publications, runtime, scheduler } = harness([main], { now: () => now });
    runtime.requestLayout(request);
    scheduler.flushQuiet();

    runtime.trackActive();
    for (const task of scheduler.frameTasks.splice(0)) task();
    now = 50;
    (second as { rect: OutlineRuntimeElement["rect"] }).rect = {
      bottom: 20,
      left: 100,
      right: 700,
      top: 0,
    };
    runtime.trackActive();
    for (const task of scheduler.frameTasks.splice(0)) task();
    expect(publications.filter(({ type }) => type === "active")).toEqual([]);

    now = 100;
    scheduler.flushQuiet();
    for (const task of scheduler.frameTasks.splice(0)) task();
    expect(publications.filter(({ type }) => type === "active")).toHaveLength(1);
  });
});
