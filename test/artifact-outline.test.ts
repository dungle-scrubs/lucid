import { describe, expect, test } from "bun:test";
import {
  activeOutlineKey,
  ARTIFACT_OUTLINE_POLICY,
  createOutlinePresentation,
  createOutlineRateGate,
  normalizeOutlineLabel,
  OUTLINE_PRESENTATION_HOVER_INTENT_MS,
  OUTLINE_PRESENTATION_HOVER_LEAVE_MS,
  OUTLINE_PRESENTATION_PENDING_HOLD_MS,
  project,
  projectOutlineHeadings,
  reduceOutlinePresentation,
  resolveOutlineActivation,
  type OutlinePresentationEvent,
  type OutlinePresentationMode,
  type OutlinePresentationState,
  type OutlineSnapshot,
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
  // Drive one lattice event through the interaction machine from a seeded mode.
  const drive = (mode: OutlinePresentationMode, event: OutlinePresentationEvent) =>
    createOutlinePresentation({ seed: state(mode) }).send(event, 0);

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
    expect(drive(mode, event).mode).toBe(expected);
  });

  test("every state becomes absent below two headings", () => {
    for (const mode of [
      "ABSENT",
      "PINNED",
      "TRANSIENT_CLOSED",
      "TRANSIENT_HOVER",
      "TRANSIENT_LATCHED",
    ] as const) {
      expect(drive(mode, projection(1, 20)).mode).toBe("ABSENT");
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
      expect(drive(mode, { type: "invalidate" }).mode).toBe("ABSENT");
    }
  });

  test("invalidation requests focus handoff before removing a focused control", () => {
    const result = drive("PINNED", { focusInside: true, type: "invalidate" });
    expect(result.mode).toBe("ABSENT");
    expect(result.effects).toEqual([{ kind: "focus-surface" }]);
  });

  test("records whether a latch came from the user or a focused gutter loss", () => {
    // latchOrigin is a pure-lattice property, asserted at the project seam; the
    // machine surfaces only the resulting mode, which both latch sources share.
    expect(project({ mode: "PINNED" }, { ...projection(2, 7), focusInside: true })).toEqual({
      state: { latchOrigin: "gutter", mode: "TRANSIENT_LATCHED" },
    });
    expect(project({ mode: "TRANSIENT_HOVER" }, { type: "latch" })).toEqual({
      state: { latchOrigin: "user", mode: "TRANSIENT_LATCHED" },
    });
    expect(
      project(
        { latchOrigin: "gutter", mode: "TRANSIENT_LATCHED" },
        { ...projection(2, 12), type: "interaction-finished" },
      ),
    ).toEqual({ state: { mode: "PINNED" } });
    expect(drive("PINNED", { ...projection(2, 7), focusInside: true }).mode).toBe(
      "TRANSIENT_LATCHED",
    );
    expect(drive("TRANSIENT_HOVER", { type: "latch" }).mode).toBe("TRANSIENT_LATCHED");
  });

  test("the four-pixel hysteresis band retains pinned at 8px but requires 12px to enter", () => {
    expect(drive("PINNED", projection(2, 8)).mode).toBe("PINNED");
    expect(drive("PINNED", projection(2, 7)).mode).toBe("TRANSIENT_CLOSED");
    expect(drive("TRANSIENT_CLOSED", projection(2, 11)).mode).toBe("TRANSIENT_CLOSED");
    expect(drive("TRANSIENT_CLOSED", projection(2, 12)).mode).toBe("PINNED");
    // preserveHysteresis remembers PINNED across a soft reproof: a 9px proof
    // (below the 12px enter gate, above the 8px retain gate) re-pins only because
    // the prior mode was PINNED. Two sends on one machine carry that memory.
    const heldPin = createOutlinePresentation({ seed: state("PINNED") });
    expect(heldPin.send({ preserveHysteresis: true, type: "invalidate" }, 0).mode).toBe("ABSENT");
    expect(heldPin.send(projection(2, 9), 0).mode).toBe("PINNED");
    // ...but a reproof that itself FAILED proof drops the retain gate: the same
    // 9px proof then lands transient, because the last settled mode was not PINNED.
    const failedProof = createOutlinePresentation({ seed: state("PINNED") });
    expect(failedProof.send({ preserveHysteresis: true, type: "invalidate" }, 0).mode).toBe(
      "ABSENT",
    );
    expect(failedProof.send(projection(2, 0, false), 0).mode).toBe("TRANSIENT_CLOSED");
    expect(failedProof.send(projection(2, 9), 0).mode).toBe("TRANSIENT_CLOSED");
    // A hard invalidate (no hysteresis) forgets PINNED entirely.
    const resetPin = createOutlinePresentation({ seed: state("PINNED") });
    expect(resetPin.send({ type: "invalidate" }, 0).mode).toBe("ABSENT");
    expect(resetPin.send(projection(2, 9), 0).mode).toBe("TRANSIENT_CLOSED");
  });
});

describe("outline presentation timer effects", () => {
  const seed = (mode: OutlinePresentationMode): OutlinePresentationState =>
    mode === "TRANSIENT_LATCHED" ? { latchOrigin: "user", mode } : { mode };

  test("pointer-enter schedules hover-intent after the hover delay, and the panel opens only when it fires", () => {
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_CLOSED") });
    const armed = machine.send({ type: "pointer-enter" }, 0);
    expect(armed.mode).toBe("TRANSIENT_CLOSED");
    expect(armed.effects).toEqual([
      {
        kind: "schedule",
        timer: "hover",
        ms: OUTLINE_PRESENTATION_HOVER_INTENT_MS,
        event: { type: "hover-intent" },
      },
    ]);
    // The adapter fires the scheduled event after the delay; only then does the
    // lattice move. Nothing opens early.
    const opened = machine.send({ type: "hover-intent" }, OUTLINE_PRESENTATION_HOVER_INTENT_MS);
    expect(opened.mode).toBe("TRANSIENT_HOVER");
    expect(opened.effects).toEqual([]);
  });

  test("pointer-exit schedules pointer-leave after the leave delay", () => {
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_HOVER") });
    const armed = machine.send({ type: "pointer-exit" }, 0);
    expect(armed.mode).toBe("TRANSIENT_HOVER");
    expect(armed.effects).toEqual([
      {
        kind: "schedule",
        timer: "leave",
        ms: OUTLINE_PRESENTATION_HOVER_LEAVE_MS,
        event: { type: "pointer-leave" },
      },
    ]);
    const closed = machine.send({ type: "pointer-leave" }, OUTLINE_PRESENTATION_HOVER_LEAVE_MS);
    expect(closed.mode).toBe("TRANSIENT_CLOSED");
  });

  test("re-entering within the hysteresis window cancels the pending close and keeps the panel open", () => {
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_HOVER") });
    machine.send({ type: "pointer-exit" }, 0); // arms the leave timer
    const reentered = machine.send({ type: "pointer-enter" }, 50); // re-enter before it fires
    expect(reentered.mode).toBe("TRANSIENT_HOVER");
    expect(reentered.effects).toEqual([{ kind: "cancel", timer: "leave" }]);
  });

  test("a pointer-exit before the hover fired cancels the pending open without arming a close", () => {
    // CLOSED, hover scheduled, pointer leaves before hover-intent fires: cancel
    // the hover, do NOT arm a leave (the panel never opened).
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_CLOSED") });
    machine.send({ type: "pointer-enter" }, 0); // arms hover
    const exited = machine.send({ type: "pointer-exit" }, 30);
    expect(exited.mode).toBe("TRANSIENT_CLOSED");
    expect(exited.effects).toEqual([{ kind: "cancel", timer: "hover" }]);
  });

  test("pointer-enter in a mode that is not closed does not arm a hover timer", () => {
    const alreadyOpen = createOutlinePresentation({ seed: seed("TRANSIENT_HOVER") });
    const result = alreadyOpen.send({ type: "pointer-enter" }, 0);
    expect(result.mode).toBe("TRANSIENT_HOVER");
    expect(result.effects).toEqual([]);
  });
});

describe("outline presentation pointer, focus and touch ordering", () => {
  const seed = (mode: OutlinePresentationMode): OutlinePresentationState =>
    mode === "TRANSIENT_LATCHED" ? { latchOrigin: "user", mode } : { mode };
  const snapshot = (overrides: Partial<OutlineSnapshot> = {}): OutlineSnapshot => ({
    activeKey: "h-1",
    available: true,
    generation: 1,
    headings: [
      { key: "h-1", label: "First" },
      { key: "h-2", label: "Second" },
    ],
    proof: { clearancePx: 0, complete: false },
    railInsetPx: ARTIFACT_OUTLINE_POLICY.railInsetPx,
    ...overrides,
  });

  test("rail-focus opens the panel from the keyboard", () => {
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_CLOSED") });
    expect(machine.send({ type: "rail-focus" }, 0).mode).toBe("TRANSIENT_LATCHED");
  });

  test("a focus that arrives during a rail pointer sequence does not latch the panel open", () => {
    // A tap (touch or mouse) synthesizes pointerdown -> focus -> pointerup. The
    // focus between the two pointer events must NOT read as a keyboard focus
    // that opens the panel; the machine suppresses it because a pointer is
    // down on the rail. A fake clock cannot catch this - it is task ordering.
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_CLOSED") });
    machine.send({ type: "rail-pointer-down" }, 0);
    const focused = machine.send({ type: "rail-focus" }, 0);
    expect(focused.mode).toBe("TRANSIENT_CLOSED");
    expect(focused.effects).toEqual([]);
    const released = machine.send({ type: "rail-pointer-up" }, 0);
    expect(released.mode).toBe("TRANSIENT_CLOSED");
    // Once the pointer is up, a genuine keyboard focus opens the panel.
    expect(machine.send({ type: "rail-focus" }, 0).mode).toBe("TRANSIENT_LATCHED");
  });

  test("rail-touch opens the panel and the synthesized close-click does not reopen or close it", () => {
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_CLOSED") });
    const opened = machine.send({ type: "rail-touch" }, 0);
    expect(opened.mode).toBe("TRANSIENT_LATCHED");
    // The browser synthesizes a click that toggles the Collapsible closed; the
    // machine suppresses exactly that one close.
    const synthesizedClose = machine.send({ type: "collapsible-change", open: false }, 0);
    expect(synthesizedClose.mode).toBe("TRANSIENT_LATCHED");
  });

  test("Escape closes the transient panel and the focus-rail it issues does not instantly reopen it", () => {
    // A proof that does not fit the gutter means the interaction ends CLOSED,
    // not re-pinned, so Escape returns focus to the rail. Focusing the rail
    // would normally open it - the machine marks that focus as its own and
    // suppresses it, keeping the panel closed.
    const machine = createOutlinePresentation({
      seed: seed("TRANSIENT_LATCHED"),
      snapshot: snapshot({ proof: { clearancePx: 0, complete: false } }),
    });
    const escaped = machine.send({ type: "escape" }, 0);
    expect(escaped.mode).toBe("TRANSIENT_CLOSED");
    expect(escaped.effects).toEqual([{ kind: "focus-rail" }]);
    // The adapter applies focus-rail synchronously; the resulting focus event is
    // the machine's own, so it is suppressed and the panel stays closed.
    const refocused = machine.send({ type: "rail-focus" }, 0);
    expect(refocused.mode).toBe("TRANSIENT_CLOSED");
    expect(refocused.effects).toEqual([]);
    // A genuine later keyboard focus still opens the panel.
    expect(machine.send({ type: "rail-focus" }, 0).mode).toBe("TRANSIENT_LATCHED");
  });

  test("Escape to pinned focuses the surface, not the rail", () => {
    const machine = createOutlinePresentation({
      seed: seed("TRANSIENT_LATCHED"),
      snapshot: snapshot({ proof: { clearancePx: 24, complete: true } }),
    });
    const escaped = machine.send({ type: "escape" }, 0);
    expect(escaped.mode).toBe("PINNED");
    expect(escaped.effects).toEqual([{ kind: "focus-surface" }]);
  });

  test("a click that opens latches, and a later click that closes ends the interaction", () => {
    const machine = createOutlinePresentation({ seed: seed("TRANSIENT_CLOSED") });
    expect(machine.send({ type: "collapsible-change", open: true }, 0).mode).toBe(
      "TRANSIENT_LATCHED",
    );
    const closed = machine.send({ type: "collapsible-change", open: false }, 0);
    expect(closed.mode).toBe("TRANSIENT_CLOSED");
  });

  test("a keyboard pick closes the interaction and returns focus to the rail; a pointer pick does not", () => {
    // A pointer pick (detail > 0): interaction ends closed, no focus handoff.
    const pointer = createOutlinePresentation({
      seed: seed("TRANSIENT_LATCHED"),
      snapshot: snapshot({ proof: { clearancePx: 0, complete: false } }),
    });
    const pointerPick = pointer.send({ type: "pick", keyboard: false }, 0);
    expect(pointerPick.mode).toBe("TRANSIENT_CLOSED");
    expect(pointerPick.effects).toEqual([]);
    // A keyboard pick: interaction ends closed and focus returns to the rail,
    // with the machine suppressing its own focus so the panel stays closed.
    const keyboard = createOutlinePresentation({
      seed: seed("TRANSIENT_LATCHED"),
      snapshot: snapshot({ proof: { clearancePx: 0, complete: false } }),
    });
    const keyboardPick = keyboard.send({ type: "pick", keyboard: true }, 0);
    expect(keyboardPick.mode).toBe("TRANSIENT_CLOSED");
    expect(keyboardPick.effects).toEqual([{ kind: "focus-rail" }]);
    expect(keyboard.send({ type: "rail-focus" }, 0).mode).toBe("TRANSIENT_CLOSED");
    // From pinned, a pick is a no-op for the lattice (pinned stays pinned).
    const pinnedPick = createOutlinePresentation({ seed: seed("PINNED") }).send(
      { type: "pick", keyboard: true },
      0,
    );
    expect(pinnedPick.mode).toBe("PINNED");
    expect(pinnedPick.effects).toEqual([]);
  });

  test("blur ends a latched interaction, and exits a pending hold early", () => {
    // A latched panel whose focus leaves ends the interaction (closes).
    const latched = createOutlinePresentation({
      seed: seed("TRANSIENT_LATCHED"),
      snapshot: snapshot({ proof: { clearancePx: 0, complete: false } }),
    });
    expect(latched.send({ type: "blur" }, 0).mode).toBe("TRANSIENT_CLOSED");
    // A pending hold that loses focus exits early: cancel the hold, drop to
    // absent preserving priorMode, clear the held snapshot.
    const held = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot() });
    held.send({ type: "snapshot-withdrawn", pending: true, focusInside: true }, 0);
    const blurred = held.send({ type: "blur" }, 0);
    expect(blurred.mode).toBe("ABSENT");
    expect(blurred.effects).toEqual([{ kind: "cancel", timer: "pending" }]);
    expect(blurred.snapshot).toBeNull();
  });

  test("a pointer press outside a latched panel ends the interaction", () => {
    const machine = createOutlinePresentation({
      seed: seed("TRANSIENT_LATCHED"),
      snapshot: snapshot({ proof: { clearancePx: 0, complete: false } }),
    });
    expect(machine.send({ type: "outside-press" }, 0).mode).toBe("TRANSIENT_CLOSED");
  });
});

describe("outline presentation snapshot selection", () => {
  const seed = (mode: OutlinePresentationMode): OutlinePresentationState =>
    mode === "TRANSIENT_LATCHED" ? { latchOrigin: "user", mode } : { mode };
  const snapshot = (
    generation: number,
    proof = { clearancePx: 24, complete: true },
  ): OutlineSnapshot => ({
    activeKey: "h-1",
    available: true,
    generation,
    headings: [
      { key: "h-1", label: "First" },
      { key: "h-2", label: "Second" },
    ],
    proof,
    railInsetPx: ARTIFACT_OUTLINE_POLICY.railInsetPx,
  });

  test("snapshot-arrived with a newer generation replaces the rendered snapshot and pins when the proof fits the gutter", () => {
    const machine = createOutlinePresentation({ seed: seed("ABSENT") });
    const result = machine.send(
      { type: "snapshot-arrived", snapshot: snapshot(5), focusInside: false },
      0,
    );
    expect(result.mode).toBe("PINNED");
    expect(result.snapshot?.generation).toBe(5);
  });

  test("snapshot-arrived projects transient when the proof does not fit the gutter", () => {
    const machine = createOutlinePresentation({ seed: seed("ABSENT") });
    const result = machine.send(
      {
        type: "snapshot-arrived",
        snapshot: snapshot(5, { clearancePx: 0, complete: false }),
        focusInside: false,
      },
      0,
    );
    expect(result.mode).toBe("TRANSIENT_CLOSED");
    expect(result.snapshot?.generation).toBe(5);
  });

  test("snapshot-arrived with a stale generation is ignored", () => {
    const machine = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot(5) });
    const result = machine.send(
      { type: "snapshot-arrived", snapshot: snapshot(3), focusInside: false },
      0,
    );
    expect(result.mode).toBe("PINNED");
    expect(result.snapshot?.generation).toBe(5); // unchanged
  });

  test("snapshot-arrived with focus on an item that survives the change keeps focus and does not hand off", () => {
    const machine = createOutlinePresentation({
      seed: seed("TRANSIENT_CLOSED"),
      snapshot: snapshot(5),
    });
    const result = machine.send(
      { type: "snapshot-arrived", snapshot: snapshot(6), focusInside: true, focusedKey: "h-1" },
      0,
    );
    expect(result.effects).toEqual([]); // no focus-surface handoff: the item survives
    expect(result.mode).toBe("PINNED");
  });

  test("snapshot-arrived with focus orphaned by the change hands focus to the surface", () => {
    const machine = createOutlinePresentation({
      seed: seed("TRANSIENT_CLOSED"),
      snapshot: snapshot(5),
    });
    const result = machine.send(
      {
        type: "snapshot-arrived",
        snapshot: snapshot(6, { clearancePx: 0, complete: false }),
        focusInside: true,
        focusedKey: "gone",
      },
      0,
    );
    expect(result.effects).toEqual([{ kind: "focus-surface" }]);
    expect(result.mode).toBe("TRANSIENT_CLOSED");
  });

  test("a pending reproof without focus returns to absent and preserves priorMode across the gap", () => {
    const machine = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot(5) });
    const withdrawn = machine.send(
      { type: "snapshot-withdrawn", pending: true, focusInside: false },
      0,
    );
    expect(withdrawn.mode).toBe("ABSENT");
    expect(withdrawn.snapshot).toBeNull();
    // A reproof that fits only the RETAIN gate (9px, below the 12px enter gate)
    // re-pins because priorMode was PINNED.
    const reproof = machine.send(
      {
        type: "snapshot-arrived",
        snapshot: snapshot(6, { clearancePx: 9, complete: true }),
        focusInside: false,
      },
      0,
    );
    expect(reproof.mode).toBe("PINNED");
  });

  test("a real loss without a pending reproof hard-resets, so the return requires the full enter gate", () => {
    const machine = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot(5) });
    machine.send({ type: "snapshot-withdrawn", pending: false, focusInside: false }, 0);
    const reproof = machine.send(
      {
        type: "snapshot-arrived",
        snapshot: snapshot(6, { clearancePx: 9, complete: true }),
        focusInside: false,
      },
      0,
    );
    expect(reproof.mode).toBe("TRANSIENT_CLOSED"); // 9px is below the 12px enter gate after a hard reset
  });

  test("a pending reproof with focus inside latches and arms the hold timer; its expiry returns to absent", () => {
    const machine = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot(5) });
    const held = machine.send({ type: "snapshot-withdrawn", pending: true, focusInside: true }, 0);
    expect(held.mode).toBe("TRANSIENT_LATCHED"); // focus survives the reproof as a gutter latch
    expect(held.effects).toEqual([
      {
        kind: "schedule",
        timer: "pending",
        ms: OUTLINE_PRESENTATION_PENDING_HOLD_MS,
        event: { type: "pending-expired" },
      },
    ]);
    // The hold expires without a fresh snapshot: focus hands off and the
    // machine goes absent, preserving priorMode across the soft reproof.
    const expired = machine.send({ type: "pending-expired", focusInside: true }, 500);
    expect(expired.mode).toBe("ABSENT");
    expect(expired.effects).toEqual([{ kind: "focus-surface" }]);
    expect(expired.snapshot).toBeNull();
  });

  test("ending an interaction during a pending reproof dismisses rather than re-pinning on the stale proof", () => {
    // The pending hold keeps the last good (still-fitting) snapshot rendered so
    // focus survives. Ending the interaction then must NOT re-pin against that
    // stale proof - the reproof is in flight - so it dismisses to closed and
    // returns focus to the rail, exactly like Escape after a gutter loss.
    const machine = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot(5) });
    machine.send({ type: "snapshot-withdrawn", pending: true, focusInside: true }, 0);
    const escaped = machine.send({ type: "escape" }, 0);
    expect(escaped.mode).toBe("TRANSIENT_CLOSED");
    expect(escaped.effects).toEqual([{ kind: "focus-rail" }]);
  });

  test("a fresh snapshot cancels an armed pending hold and updates the rendered snapshot", () => {
    // The pending latch holds focus while a reproof is in flight. When the fresh
    // snapshot returns, the hold is cancelled and the rendered snapshot updates;
    // a projection arriving while latched is ignored by the lattice, so the
    // panel stays latched open showing the new snapshot until the next
    // interaction - matching the component's pre-refactor behavior.
    const machine = createOutlinePresentation({ seed: seed("PINNED"), snapshot: snapshot(5) });
    machine.send({ type: "snapshot-withdrawn", pending: true, focusInside: true }, 0);
    const reproof = machine.send(
      { type: "snapshot-arrived", snapshot: snapshot(6), focusInside: true, focusedKey: "h-1" },
      0,
    );
    expect(reproof.effects).toEqual([{ kind: "cancel", timer: "pending" }]);
    expect(reproof.mode).toBe("TRANSIENT_LATCHED");
    expect(reproof.snapshot?.generation).toBe(6);
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
