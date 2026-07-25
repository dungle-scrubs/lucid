import { describe, expect, test } from "bun:test";
import {
  advance,
  buildItems,
  draftFor,
  draftIssues,
  firstInvalidIndex,
  goToTab,
  groupOf,
  initialDraft,
  legacyAnswerFields,
  selectCustom,
  setCustomText,
  setReason,
  toggleChoice,
  toggleDefer,
} from "../client/chrome/question-draft.ts";
import {
  normalizeQuestionGroup,
  type QuestionGroup,
  validateAnswer,
} from "../src/core/question-contract.ts";
import type { AgentQuestion } from "../client/chrome/types.ts";

/**
 * The question drawer's view-model (D11/D12). Pure, so it is tested without a
 * DOM: every rule about what a selection means lives here, and the drawer is
 * only presentation over it.
 */

const asked = (over: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id: "q-1",
  text: "Which store?",
  answered: false,
  ...over,
});

const group = (raw: unknown): QuestionGroup => normalizeQuestionGroup(raw);

const single = group([
  {
    id: "store",
    question: "Which store?",
    choices: [
      { id: "pg", label: "Postgres", recommended: true },
      { id: "sqlite", label: "SQLite" },
    ],
  },
]);

describe("groupOf", () => {
  test("a legacy question becomes a one-item group the drawer can render", () => {
    const g = groupOf(
      asked({ options: [{ label: "Postgres", description: "boring" }, { label: "SQLite" }] }),
    );
    expect(g).toHaveLength(1);
    expect(g[0]?.answerShape).toBe("single_choice");
    expect(g[0]?.choices.map((c) => c.label)).toEqual(["Postgres", "SQLite"]);
    expect(g[0]?.question).toBe("Which store?");
  });

  test("a legacy question with no options is free text", () => {
    expect(groupOf(asked())[0]?.answerShape).toBe("free_text");
  });

  test("a grouped question passes through untouched", () => {
    const g = groupOf(asked({ group: single }));
    expect(g).toBe(single);
  });
});

describe("initialDraft", () => {
  test("pre-selects the recommended choice of a SINGLE-choice question only", () => {
    expect(draftFor(initialDraft(single), "store").selectedIds).toEqual(["pg"]);
  });

  test("leaves a multi-select empty: picking for the human is not a default", () => {
    const multi = group([
      {
        id: "areas",
        question: "Which areas?",
        multi: true,
        choices: [
          { id: "api", label: "API", recommended: true },
          { id: "ui", label: "UI" },
        ],
      },
    ]);
    expect(draftFor(initialDraft(multi), "areas").selectedIds).toEqual([]);
  });
});

describe("selection rules", () => {
  const item = single[0];
  if (!item) throw new Error("fixture");

  test("single-choice re-selection KEEPS the choice rather than clearing it", () => {
    const d = toggleChoice(toggleChoice(initialDraft(single), item, "sqlite"), item, "sqlite");
    expect(draftFor(d, "store").selectedIds).toEqual(["sqlite"]);
  });

  test("multi-select toggles both ways", () => {
    const multi = group([
      {
        id: "areas",
        question: "Which areas?",
        multi: true,
        choices: [
          { id: "api", label: "API" },
          { id: "ui", label: "UI" },
        ],
      },
    ]);
    const m = multi[0];
    if (!m) throw new Error("fixture");
    const on = toggleChoice(toggleChoice(initialDraft(multi), m, "api"), m, "ui");
    expect(draftFor(on, "areas").selectedIds).toEqual(["api", "ui"]);
    expect(draftFor(toggleChoice(on, m, "api"), "areas").selectedIds).toEqual(["ui"]);
  });

  test("TYPING selects the custom row and drops the single choice", () => {
    const d = setCustomText(initialDraft(single), item, "DuckDB");
    expect(draftFor(d, "store").customSelected).toBe(true);
    expect(draftFor(d, "store").selectedIds).toEqual([]);
  });

  test("choosing a real choice again drops the custom row", () => {
    const d = toggleChoice(setCustomText(initialDraft(single), item, "DuckDB"), item, "pg");
    expect(draftFor(d, "store").customSelected).toBe(false);
  });

  test("selectCustom is the deliberate keyboard/click path, distinct from typing", () => {
    const d = selectCustom(initialDraft(single), item);
    expect(draftFor(d, "store").customSelected).toBe(true);
    expect(draftFor(d, "store").customText).toBe("");
  });

  test("answering un-defers a deferred question", () => {
    const deferred = toggleDefer(initialDraft(single), "store");
    expect(draftFor(deferred, "store").deferred).toBe(true);
    expect(draftFor(toggleChoice(deferred, item, "pg"), "store").deferred).toBe(false);
  });
});

describe("buildItems", () => {
  test("a single-choice custom answer rides `text`, not a fake selection", () => {
    const item = single[0];
    if (!item) throw new Error("fixture");
    const items = buildItems(single, setCustomText(initialDraft(single), item, "DuckDB"));
    expect(items[0]).toEqual({ id: "store", text: "DuckDB" });
  });

  test("a multi-select custom answer rides `selected` beside the chosen labels", () => {
    const multi = group([
      {
        id: "areas",
        question: "Which areas?",
        multi: true,
        choices: [{ id: "api", label: "API" }],
      },
    ]);
    const m = multi[0];
    if (!m) throw new Error("fixture");
    const d = setCustomText(toggleChoice(initialDraft(multi), m, "api"), m, "Docs");
    expect(buildItems(multi, d)[0]?.selected).toEqual([
      { id: "api", label: "API" },
      { label: "Docs", custom: true },
    ]);
  });

  test("a deferred question carries nothing but its deferral", () => {
    const d = setReason(toggleDefer(initialDraft(single), "store"), "store", "later");
    expect(buildItems(single, d)[0]).toEqual({ id: "store", defer: true });
  });
});

describe("gating", () => {
  test("the drawer's gate IS the server's validator: a ready draft validates", () => {
    const d = initialDraft(single);
    expect(draftIssues(single, d)).toEqual([]);
    expect(validateAnswer(single, { items: buildItems(single, d) })).toEqual([]);
  });

  test("a required reason blocks submit until it is filled", () => {
    const g = group([
      {
        id: "cut",
        question: "Cut over when?",
        requiresReason: true,
        choices: [{ id: "now", label: "Now", recommended: true }],
      },
    ]);
    expect(draftIssues(g, initialDraft(g)).map((i) => i.code)).toEqual(["missing_reason"]);
    expect(draftIssues(g, setReason(initialDraft(g), "cut", "the window is open"))).toEqual([]);
  });

  test("free text is unanswered until something is typed", () => {
    const g = group([{ id: "why", question: "Why?" }]);
    const item = g[0];
    if (!item) throw new Error("fixture");
    expect(draftIssues(g, initialDraft(g)).map((i) => i.code)).toEqual(["missing_text"]);
    expect(draftIssues(g, setCustomText(initialDraft(g), item, "because"))).toEqual([]);
  });

  test("a deferral only satisfies a question that allows one", () => {
    const g = group([
      { id: "a", question: "A?", allowDefer: true, choices: [{ id: "x", label: "X" }] },
      { id: "b", question: "B?", choices: [{ id: "y", label: "Y" }] },
    ]);
    const d = toggleDefer(toggleDefer(initialDraft(g), "a"), "b");
    const codes = draftIssues(g, d).map((i) => `${i.questionId}:${i.code}`);
    expect(codes).toEqual(["b:missing_selection"]);
  });
});

describe("the tab cursor", () => {
  // Free-text questions: the only shape that arrives with NOTHING staged.
  // Single-choice now auto-selects (recommended, else first), so a choice
  // pair could never exercise the incomplete-tab gating below.
  const pair = group([
    { id: "a", question: "A?" },
    { id: "b", question: "B?" },
  ]);

  test("a single-choice question arrives with a selection: recommended, else the first", () => {
    const g = group([
      {
        id: "rec",
        question: "R?",
        choices: [
          { id: "x", label: "X" },
          { id: "y", label: "Y", recommended: true },
        ],
      },
      {
        id: "plain",
        question: "P?",
        choices: [
          { id: "p", label: "P" },
          { id: "q", label: "Q" },
        ],
      },
      { id: "multi", question: "M?", multi: true, choices: [{ id: "m", label: "M" }] },
    ]);
    const d = initialDraft(g);
    expect(d.byId.rec?.selectedIds).toEqual(["y"]);
    expect(d.byId.plain?.selectedIds).toEqual(["p"]);
    // Multi-select stays empty: an empty set is a real answer there.
    expect(d.byId.multi?.selectedIds ?? []).toEqual([]);
  });

  test("advance refuses to skip an unanswered question", () => {
    expect(advance(pair, initialDraft(pair)).activeIndex).toBe(0);
  });

  test("advance moves on once the current question is answered", () => {
    const a = pair[0];
    if (!a) throw new Error("fixture");
    const d = setCustomText(initialDraft(pair), a, "an answer");
    expect(advance(pair, d).activeIndex).toBe(1);
  });

  test("goToTab clamps to a real tab", () => {
    expect(goToTab(initialDraft(pair), 9, pair.length).activeIndex).toBe(1);
    expect(goToTab(initialDraft(pair), -3, pair.length).activeIndex).toBe(0);
  });

  test("firstInvalidIndex names the tab the final-tab jump goes to", () => {
    const b = pair[1];
    if (!b) throw new Error("fixture");
    const d = setCustomText(initialDraft(pair), b, "b's answer");
    expect(firstInvalidIndex(pair, d)).toBe(0);
    const a = pair[0];
    if (!a) throw new Error("fixture");
    expect(firstInvalidIndex(pair, setCustomText(d, a, "a's answer"))).toBe(-1);
  });
});

describe("legacyAnswerFields", () => {
  test("chosen labels ride `options`; the custom row rides `text`", () => {
    const g = groupOf(asked({ options: [{ label: "Postgres" }, { label: "SQLite" }] }));
    const item = g[0];
    if (!item) throw new Error("fixture");
    const chosen = toggleChoice(initialDraft(g), item, item.choices[0]?.id ?? "");
    expect(legacyAnswerFields(g, chosen)).toEqual({ text: "", options: ["Postgres"] });
    const typed = setCustomText(initialDraft(g), item, "DuckDB");
    expect(legacyAnswerFields(g, typed)).toEqual({ text: "DuckDB", options: [] });
  });
});
