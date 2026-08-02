import { describe, expect, test } from "bun:test";
import {
  activeOutlineKey,
  ARTIFACT_OUTLINE_POLICY,
  createOutlineRateGate,
  normalizeOutlineLabel,
  projectOutlineHeadings,
  reduceOutlinePresentation,
  resolveOutlineActivation,
  type OutlinePresentationMode,
  type OutlinePresentationState,
  validateOutlineSnapshot,
} from "../client/shared/artifact-outline.ts";
import { validateOutlinePrivateInbound } from "../client/shared/protocol.ts";

describe("artifact outline labels", () => {
  test("normalizes whitespace and refuses an empty result", () => {
    expect(normalizeOutlineLabel("  First\n\t section  ")).toBe("First section");
    expect(normalizeOutlineLabel(" \n\t ")).toBeNull();
    expect(normalizeOutlineLabel(`${" ".repeat(240)}A`)).toBe("A");
    expect(normalizeOutlineLabel(" ".repeat(4_097))).toBeNull();
  });

  test("all initial presentation and work budgets live in one module-private literal policy", () => {
    expect(Object.isFrozen(ARTIFACT_OUTLINE_POLICY)).toBe(false);
    expect(ARTIFACT_OUTLINE_POLICY).toMatchObject({
      maxActiveKeysPerSecond: 10,
      maxAggregateLabelCodeUnits: 8_192,
      maxAggregateExaminedLabelCodeUnits: 32_768,
      maxExaminedLabelCodeUnits: 4_096,
      maxHeadings: 64,
      maxLabelCodeUnits: 240,
      maxPreferredWidthPx: 1_024,
      maxSnapshotsPerSecond: 4,
      maxTextNodesPerHeading: 4_096,
      outlineWidthPx: 240,
      paintClearancePx: 12,
      pinnedEnterClearancePx: 12,
      pinnedRetainClearancePx: 8,
      proofElementLimit: 2_000,
      proofTimeBudgetMs: 8,
      quietLayoutMs: 40,
      railInsetPx: 18,
    });
  });
});

describe("artifact outline protocol bounds", () => {
  test("one private inbound parser enforces layout and activation identity bounds", () => {
    expect(
      validateOutlinePrivateInbound({
        type: "outline-layout-request",
        generation: 1,
        preferredWidth: 240,
        safeInsets: { bottom: 24, right: 16, top: 80 },
      }),
    ).toMatchObject({ type: "outline-layout-request", generation: 1 });
    expect(
      validateOutlinePrivateInbound({
        type: "outline-activate",
        generation: 1,
        key: "heading\nforged",
        motion: "normal",
      }),
    ).toBeNull();
    expect(
      validateOutlinePrivateInbound({
        type: "outline-layout-request",
        generation: 1,
        preferredWidth: 1_025,
        safeInsets: { bottom: 0, right: 0, top: 0 },
      }),
    ).toBeNull();
  });

  test("limits snapshots to four and active keys to ten per rolling second", () => {
    const gate = createOutlineRateGate();
    expect(Array.from({ length: 4 }, () => gate.accept("snapshot", 100))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(gate.accept("snapshot", 100)).toBe(false);
    expect(Array.from({ length: 10 }, () => gate.accept("active-key", 200)).every(Boolean)).toBe(
      true,
    );
    expect(gate.accept("active-key", 200)).toBe(false);
    expect(gate.accept("snapshot", 1_101)).toBe(true);
    expect(gate.accept("snapshot", Number.POSITIVE_INFINITY)).toBe(false);
    expect(gate.accept("snapshot", 1_000)).toBe(false);
    expect(gate.accept("snapshot", 2_102)).toBe(true);
  });

  test("malformed or excessive snapshots are rejected before state mutation", () => {
    const valid = {
      activeKey: "a",
      availability: "complete",
      generation: 2,
      headings: [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta" },
      ],
      proof: { clearancePx: 9, complete: true, reason: "complete-unused-rectangle" },
      requestGeneration: 1,
    } as const;
    const validate = (value: unknown) => validateOutlineSnapshot(value, { trustedGeometry: true });
    expect(validateOutlineSnapshot(valid)).toBeNull();
    expect(validate(valid)).toEqual({
      activeKey: "a",
      available: true,
      generation: 2,
      headings: [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta" },
      ],
      proof: { clearancePx: 9, complete: true },
      railInsetPx: 18,
    });
    expect(validate({ ...valid, generation: Number.NaN })).toBeNull();
    expect(validate({ ...valid, headings: "not-an-array" })).toBeNull();
    expect(
      validate({
        ...valid,
        headings: Array.from({ length: 65 }, (_, index) => ({
          key: `h${index}`,
          label: "Heading",
        })),
      }),
    ).toBeNull();
    expect(
      validate({
        ...valid,
        headings: [
          { key: "a", label: "x".repeat(241) },
          { key: "b", label: "Beta" },
        ],
      }),
    ).toBeNull();
    expect(
      validate({
        ...valid,
        headings: Array.from({ length: 35 }, (_, index) => ({
          key: `h${index}`,
          label: "x".repeat(240),
        })),
      }),
    ).toBeNull();
    expect(
      validate({
        ...valid,
        headings: [
          { key: "a", label: "Alpha" },
          { key: "a", label: "Beta" },
        ],
      }),
    ).toBeNull();
    expect(validate({ ...valid, activeKey: "missing" })).toBeNull();
    expect(
      validate({
        ...valid,
        headings: [
          { key: "a", label: " Alpha " },
          { key: "b", label: "Beta" },
        ],
      }),
    ).toBeNull();
    expect(validate({ ...valid, proof: { clearancePx: Number.NaN, complete: true } })).toBeNull();

    const snapshot = validate(valid);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(
      reduceOutlinePresentation({ mode: "PINNED" }, projectionEvent(snapshot.proof)).state.mode,
    ).toBe("PINNED");
    expect(
      reduceOutlinePresentation({ mode: "TRANSIENT_CLOSED" }, projectionEvent(snapshot.proof)).state
        .mode,
    ).toBe("TRANSIENT_CLOSED");
  });
});

const projectionEvent = (proof: { readonly clearancePx: number; readonly complete: boolean }) => ({
  type: "projection" as const,
  headingCount: 2,
  proof,
});

describe("artifact outline presentation state machine", () => {
  const state = (mode: OutlinePresentationMode): OutlinePresentationState =>
    mode === "TRANSIENT_LATCHED" ? { latchOrigin: "user", mode } : { mode };
  const projection = (headingCount: number, clearancePx: number, complete = true) => ({
    type: "projection" as const,
    headingCount,
    proof: { clearancePx, complete },
  });

  test.each([
    ["absent -> pinned", "ABSENT", projection(2, 12), "PINNED"],
    ["absent -> transient closed", "ABSENT", projection(2, 0, false), "TRANSIENT_CLOSED"],
    ["pinned -> absent", "PINNED", projection(1, 20), "ABSENT"],
    ["pinned -> transient closed on gutter loss", "PINNED", projection(2, 7), "TRANSIENT_CLOSED"],
    [
      "pinned -> transient latched while focused",
      "PINNED",
      { ...projection(2, 7), focusInside: true },
      "TRANSIENT_LATCHED",
    ],
    ["transient closed -> pinned", "TRANSIENT_CLOSED", projection(2, 12), "PINNED"],
    ["transient closed -> hover", "TRANSIENT_CLOSED", { type: "hover-intent" }, "TRANSIENT_HOVER"],
    ["transient closed -> latched", "TRANSIENT_CLOSED", { type: "latch" }, "TRANSIENT_LATCHED"],
    [
      "transient hover -> closed on leave",
      "TRANSIENT_HOVER",
      { type: "pointer-leave" },
      "TRANSIENT_CLOSED",
    ],
    [
      "transient hover -> closed on activation",
      "TRANSIENT_HOVER",
      { type: "activate" },
      "TRANSIENT_CLOSED",
    ],
    ["transient hover -> latched", "TRANSIENT_HOVER", { type: "latch" }, "TRANSIENT_LATCHED"],
    ["transient hover -> pinned", "TRANSIENT_HOVER", projection(2, 12), "PINNED"],
    [
      "transient latched -> closed on activation",
      "TRANSIENT_LATCHED",
      { type: "activate" },
      "TRANSIENT_CLOSED",
    ],
    [
      "transient latched -> closed on dismissal",
      "TRANSIENT_LATCHED",
      { type: "dismiss" },
      "TRANSIENT_CLOSED",
    ],
    [
      "transient latched -> pinned after interaction",
      "TRANSIENT_LATCHED",
      { ...projection(2, 12), type: "interaction-finished" },
      "PINNED",
    ],
  ] as const)("%s", (_name, mode, event, expected) => {
    expect(reduceOutlinePresentation(state(mode), event).state.mode).toBe(expected);
  });

  test("every state becomes absent below two headings", () => {
    for (const mode of [
      "ABSENT",
      "PINNED",
      "TRANSIENT_CLOSED",
      "TRANSIENT_HOVER",
      "TRANSIENT_LATCHED",
    ] as const) {
      expect(reduceOutlinePresentation(state(mode), projection(1, 20)).state.mode).toBe("ABSENT");
    }
  });

  test("every state invalidates immediately", () => {
    for (const mode of [
      "ABSENT",
      "PINNED",
      "TRANSIENT_CLOSED",
      "TRANSIENT_HOVER",
      "TRANSIENT_LATCHED",
    ] as const) {
      expect(reduceOutlinePresentation(state(mode), { type: "invalidate" }).state.mode).toBe(
        "ABSENT",
      );
    }
  });

  test("invalidation requests focus handoff before removing a focused control", () => {
    expect(
      reduceOutlinePresentation({ mode: "PINNED" }, { type: "invalidate", focusInside: true }),
    ).toEqual({ effects: ["focus-surface"], state: { mode: "ABSENT" } });
  });

  test("records whether a latch came from the user or a focused gutter loss", () => {
    expect(
      reduceOutlinePresentation({ mode: "PINNED" }, { ...projection(2, 7), focusInside: true }),
    ).toEqual({ state: { latchOrigin: "gutter", mode: "TRANSIENT_LATCHED" } });
    expect(reduceOutlinePresentation({ mode: "TRANSIENT_HOVER" }, { type: "latch" })).toEqual({
      state: { latchOrigin: "user", mode: "TRANSIENT_LATCHED" },
    });
    expect(
      reduceOutlinePresentation(
        { latchOrigin: "gutter", mode: "TRANSIENT_LATCHED" },
        { ...projection(2, 12), type: "interaction-finished" },
      ),
    ).toEqual({ state: { mode: "PINNED" } });
  });

  test("the four-pixel hysteresis band retains pinned at 8px but requires 12px to enter", () => {
    expect(reduceOutlinePresentation({ mode: "PINNED" }, projection(2, 8)).state.mode).toBe(
      "PINNED",
    );
    expect(reduceOutlinePresentation({ mode: "PINNED" }, projection(2, 7)).state.mode).toBe(
      "TRANSIENT_CLOSED",
    );
    expect(
      reduceOutlinePresentation({ mode: "TRANSIENT_CLOSED" }, projection(2, 11)).state.mode,
    ).toBe("TRANSIENT_CLOSED");
    expect(
      reduceOutlinePresentation({ mode: "TRANSIENT_CLOSED" }, projection(2, 12)).state.mode,
    ).toBe("PINNED");
    const invalidatedPinned = reduceOutlinePresentation(
      { mode: "PINNED" },
      { preserveHysteresis: true, type: "invalidate" },
    ).state;
    expect(reduceOutlinePresentation(invalidatedPinned, projection(2, 9)).state.mode).toBe(
      "PINNED",
    );
    const failedProof = reduceOutlinePresentation(invalidatedPinned, projection(2, 0, false)).state;
    expect(reduceOutlinePresentation(failedProof, projection(2, 9)).state.mode).toBe(
      "TRANSIENT_CLOSED",
    );
    const resetPinned = reduceOutlinePresentation({ mode: "PINNED" }, { type: "invalidate" }).state;
    expect(reduceOutlinePresentation(resetPinned, projection(2, 9)).state.mode).toBe(
      "TRANSIENT_CLOSED",
    );
  });
});

describe("artifact outline navigation identity", () => {
  test("selects the last heading above the reading threshold and otherwise the first upcoming", () => {
    const headings = [
      { key: "one", top: 120 },
      { key: "two", top: 400 },
      { key: "three", top: 800 },
    ];
    expect(activeOutlineKey(headings)).toBe("one");
    expect(
      activeOutlineKey(headings.map((heading) => ({ ...heading, top: heading.top - 50 }))),
    ).toBe("one");
    expect(
      activeOutlineKey(headings.map((heading) => ({ ...heading, top: heading.top - 500 }))),
    ).toBe("two");
    expect(
      activeOutlineKey([
        { key: "one", top: -100 },
        { key: "two", top: 300 },
        { key: "three", top: 50 },
      ]),
    ).toBe("three");
  });

  test("rejects stale generations and unknown keys with AO-002 health", () => {
    const projection = projectOutlineHeadings(12, [
      { key: "one", text: "One" },
      { key: "two", text: "Two" },
    ]);
    expect(resolveOutlineActivation(projection, { generation: 11, key: "one" })).toMatchObject({
      accepted: false,
      health: { code: "AO-002", generation: 12 },
    });
    expect(resolveOutlineActivation(projection, { generation: 12, key: "missing" })).toMatchObject({
      accepted: false,
      health: { code: "AO-002" },
    });
    expect(resolveOutlineActivation(projection, { generation: 12, key: "two" })).toEqual({
      accepted: true,
      key: "two",
    });
  });
});

describe("artifact outline projection", () => {
  test("fewer than two headings is absent and complete projections preserve order", () => {
    expect(projectOutlineHeadings(3, [{ key: "a", text: "Only" }])).toEqual({
      generation: 3,
      kind: "absent",
    });

    expect(
      projectOutlineHeadings(4, [
        { key: "second", text: "  Second  " },
        { key: "first", text: "First" },
      ]),
    ).toEqual({
      generation: 4,
      headings: [
        { key: "second", label: "Second" },
        { key: "first", label: "First" },
      ],
      kind: "complete",
    });
  });

  test("rejects incomplete, oversized, and duplicate-key projections before publication", () => {
    expect(normalizeOutlineLabel("x".repeat(241))).toBeNull();
    expect(
      projectOutlineHeadings(
        5,
        Array.from({ length: 65 }, (_, index) => ({ key: `h${index}`, text: "Heading" })),
      ),
    ).toMatchObject({ kind: "invalid", health: { code: "AO-001", reason: "heading-count" } });
    expect(
      projectOutlineHeadings(6, [
        { key: "a", text: "First" },
        { key: "b", text: "x".repeat(241) },
      ]),
    ).toMatchObject({ kind: "invalid", health: { reason: "label-length" } });
    expect(
      projectOutlineHeadings(
        7,
        Array.from({ length: 35 }, (_, index) => ({ key: `h${index}`, text: "x".repeat(240) })),
      ),
    ).toMatchObject({ kind: "invalid", health: { reason: "aggregate-label-length" } });
    expect(
      projectOutlineHeadings(8, [
        { key: "same", text: "First" },
        { key: "same", text: "Second" },
      ]),
    ).toMatchObject({ kind: "invalid", health: { reason: "duplicate-key" } });
    expect(
      projectOutlineHeadings(9, [
        { key: "a", text: "First" },
        { key: "b", text: " \n " },
      ]),
    ).toMatchObject({ kind: "invalid", health: { reason: "empty-label" } });
    expect(
      projectOutlineHeadings(10, [
        { key: "", text: "First" },
        { key: "b", text: "Second" },
      ]),
    ).toMatchObject({ kind: "invalid", health: { reason: "invalid-key" } });
    expect(
      projectOutlineHeadings(11, [
        { key: "x".repeat(129), text: "First" },
        { key: "b", text: "Second" },
      ]),
    ).toMatchObject({ kind: "invalid", health: { reason: "invalid-key" } });
    expect(
      projectOutlineHeadings(12, [
        { key: "bad\nkey", text: "First" },
        { key: "b", text: "Second" },
      ]),
    ).toMatchObject({ kind: "invalid", health: { reason: "invalid-key" } });
  });
});
