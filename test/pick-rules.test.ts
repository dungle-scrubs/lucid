import { describe, expect, test } from "bun:test";
import { resolvePick, type PickState } from "../client/chrome/actions.ts";
import { MAX_PICK_TARGETS } from "../client/chrome/store.ts";
import type { Anchor } from "../client/shared/capture.ts";

const anchor = (id: string): Anchor =>
  ({ kind: "element", domPath: [id], fingerprint: id, snippet: "" }) as unknown as Anchor;

const state = (overrides: Partial<PickState> = {}): PickState => ({
  answerAnchorLists: {},
  answerAnchors: {},
  answerPickFor: null,
  forkId: null,
  pendingDecision: null,
  pendingTarget: null,
  pendingTargets: [],
  questionDrawerDismissed: [],
  questions: [],
  viewingVersion: null,
  ...overrides,
});

const pick = (
  a: Anchor,
  mods: { meta?: boolean; shift?: boolean } = {},
): Parameters<typeof resolvePick>[1] => ({
  anchor: a,
  decision: undefined,
  modifiers: { meta: mods.meta ?? false, shift: mods.shift ?? false },
});

describe("resolvePick", () => {
  test("a pick while viewing a historical version is refused (read-only guard)", () => {
    const result = resolvePick(state({ viewingVersion: 3 }), pick(anchor("a")));
    expect(result.kind).toBe("drop");
  });

  test("a plain pick starts a composer draft", () => {
    const result = resolvePick(state(), pick(anchor("a")));
    expect(result).toMatchObject({
      kind: "apply",
      patch: {
        pendingTargets: [anchor("a")],
        pendingTarget: anchor("a"),
        pendingDecision: null,
        forkId: null,
      },
    });
  });

  test("cmd-pick toggles into the collection instead of replacing", () => {
    const result = resolvePick(
      state({ pendingTargets: [anchor("a")] }),
      pick(anchor("b"), { meta: true }),
    );
    expect(result).toMatchObject({
      kind: "apply",
      patch: {
        pendingTargets: [anchor("a"), anchor("b")],
        pendingTarget: anchor("a"),
      },
    });
  });

  test("cmd-pick toggling the last spot off discards the draft", () => {
    const result = resolvePick(
      state({ pendingTargets: [anchor("a")] }),
      pick(anchor("a"), { meta: true }),
    );
    expect(result.kind).toBe("discard-pending");
  });

  test("the cap holds at MAX_PICK_TARGETS and emits its notice", () => {
    const full = Array.from({ length: MAX_PICK_TARGETS }, (_, i) => anchor(`s${i}`));
    const result = resolvePick(
      state({ pendingTargets: full }),
      pick(anchor("overflow"), { meta: true }),
    );
    expect(result.kind).toBe("cap");
  });

  test("a pick with an armed answer target pins onto the outstanding question", () => {
    const result = resolvePick(state({ answerPickFor: "q1" }), pick(anchor("pin")));
    expect(result).toMatchObject({
      kind: "apply",
      patch: {
        answerAnchors: { q1: anchor("pin") },
        answerAnchorLists: { q1: [anchor("pin")] },
        answerPickFor: null,
        questionDrawerDismissed: [],
      },
    });
  });

  test("a shift-pick with an open question pins rather than starting a draft", () => {
    const result = resolvePick(
      state({ questions: [{ id: "q1", answered: false }] }),
      pick(anchor("pin"), { shift: true }),
    );
    expect(result).toMatchObject({
      kind: "apply",
      patch: {
        answerAnchors: { q1: anchor("pin") },
        answerPickFor: null,
      },
    });
  });

  test("pendingDecision follows latest-wins (the decision from the latest pick)", () => {
    const decision = anchor("dec");
    const result = resolvePick(state(), {
      anchor: anchor("a"),
      decision,
      modifiers: { meta: false, shift: false },
    });
    expect(result).toMatchObject({
      kind: "apply",
      patch: { pendingDecision: decision },
    });
  });

  test("a shift-pin raises a lowered question drawer", () => {
    const result = resolvePick(
      state({
        questionDrawerDismissed: ["q1"],
        questions: [{ id: "q1", answered: false }],
      }),
      pick(anchor("pin"), { shift: true }),
    );
    expect(result).toMatchObject({
      kind: "apply",
      patch: { questionDrawerDismissed: [] },
    });
  });
});
