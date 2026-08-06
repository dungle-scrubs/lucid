import {
  type AnswerContext,
  type AnswerIssue,
  type ItemAnswer,
  normalizeItemAnswers,
  normalizeQuestionGroup,
  type QuestionGroup,
  type QuestionItem,
  type SelectedChoice,
  validateAnswer,
} from "../shared/question-contract.ts";
import type { AgentQuestion } from "./types.ts";

/**
 * The write side of the question drawer: the answer DRAFT the human builds
 * while a group is pending, and the pure transforms between it and the wire
 * answer.
 *
 * The read side is the contract itself (`QuestionGroup`), which the drawer
 * renders directly. Everything here is pure so it lives in the session store
 * (a lowered drawer must not lose a draft) and is testable without a DOM.
 *
 * Submit is gated by the SAME `validateAnswer` the server re-runs on accept,
 * so the drawer can never produce an answer the server would refuse.
 */

/** One question's editable answer. */
export interface ItemDraft {
  /** Chosen choice ids: single-choice holds 0 or 1, multi-select 0 or more. */
  readonly selectedIds: readonly string[];
  /** The free-text answer, or the custom ("Other") row of a choice question. */
  readonly customText: string;
  /** The custom row is the answer (single-choice) / is included (multi-select). */
  readonly customSelected: boolean;
  readonly reason: string;
  readonly deferred: boolean;
}

/** A whole group's draft: one entry per question plus the active tab cursor. */
export interface GroupDraft {
  readonly byId: Readonly<Record<string, ItemDraft>>;
  readonly activeIndex: number;
}

const EMPTY: ItemDraft = {
  selectedIds: [],
  customText: "",
  customSelected: false,
  reason: "",
  deferred: false,
};

/**
 * The canonical group behind a wire question. A grouped ask carries `group`
 * verbatim; a legacy one (text + options + multi) folds into a ONE-item group
 * through the shared normalizer, so the drawer has exactly one shape to render
 * and the submit path branches only at the wire, not in the UI.
 */
export const groupOf = (q: AgentQuestion): QuestionGroup =>
  q.group && q.group.length > 0
    ? q.group
    : normalizeQuestionGroup({
        id: q.id,
        text: q.text,
        ...(q.options ? { options: q.options } : {}),
        ...(q.multi ? { multi: true } : {}),
      });

/**
 * Seed the draft the drawer opens with. A single-choice question starts on its
 * recommended option so the common case is one keystroke from done (D12);
 * multi-select and free text start empty, because pre-selecting one of several
 * allowed answers would be the drawer answering for the human.
 */
export const initialDraft = (group: QuestionGroup): GroupDraft => {
  const byId: Record<string, ItemDraft> = {};
  for (const q of group) {
    // A single-choice question always ARRIVES with a selection - the
    // recommended row when the asker marked one, else simply the first - so
    // Enter alone is always an answer. Multi-select stays empty: an empty
    // set is a real answer there, and pre-checking one would fake a lean.
    const preset = q.multiSelect
      ? undefined
      : (q.choices.find((c) => c.recommended) ?? q.choices[0]);
    byId[q.id] = preset ? { ...EMPTY, selectedIds: [preset.id] } : EMPTY;
  }
  return { byId, activeIndex: 0 };
};

/** Read one question's draft, defaulting rather than throwing: a group can gain
 *  a question between a bootstrap and a render, and a missing entry is empty. */
export const draftFor = (draft: GroupDraft, id: string): ItemDraft => draft.byId[id] ?? EMPTY;

const patch = (draft: GroupDraft, id: string, change: Partial<ItemDraft>): GroupDraft => ({
  ...draft,
  byId: { ...draft.byId, [id]: { ...draftFor(draft, id), ...change } },
});

/**
 * Choose a choice. Multi-select adds/removes it; single-choice only ever SETS
 * the selection - re-clicking the chosen row keeps it rather than leaving the
 * question unanswered - and drops the custom row. Either way the question stops
 * being deferred, since the human just answered it.
 */
export const toggleChoice = (draft: GroupDraft, q: QuestionItem, choiceId: string): GroupDraft => {
  const current = draftFor(draft, q.id);
  if (q.multiSelect) {
    const selectedIds = current.selectedIds.includes(choiceId)
      ? current.selectedIds.filter((id) => id !== choiceId)
      : [...current.selectedIds, choiceId];
    return patch(draft, q.id, { selectedIds, deferred: false });
  }
  return patch(draft, q.id, {
    selectedIds: [choiceId],
    customSelected: false,
    deferred: false,
  });
};

/** Choose the custom row deliberately (click on its indicator / arrow onto it). */
export const selectCustom = (draft: GroupDraft, q: QuestionItem): GroupDraft => {
  const current = draftFor(draft, q.id);
  if (q.multiSelect) {
    return patch(draft, q.id, { customSelected: !current.customSelected, deferred: false });
  }
  return patch(draft, q.id, { selectedIds: [], customSelected: true, deferred: false });
};

/**
 * Set the custom / free-text answer. TYPING is what selects the custom row -
 * focus alone never does (D12). Focusing a full-width row would otherwise clear
 * a required single-choice selection before the human typed anything.
 */
export const setCustomText = (draft: GroupDraft, q: QuestionItem, text: string): GroupDraft =>
  patch(draft, q.id, {
    customText: text,
    customSelected: true,
    ...(q.multiSelect ? {} : { selectedIds: [] }),
    deferred: false,
  });

export const setReason = (draft: GroupDraft, id: string, reason: string): GroupDraft =>
  patch(draft, id, { reason });

/** Defer one question (only offered where `allowDefer`). */
export const toggleDefer = (draft: GroupDraft, id: string): GroupDraft =>
  patch(draft, id, { deferred: !draftFor(draft, id).deferred });

/** Fold one question's draft into its wire answer. */
export const buildItemAnswer = (q: QuestionItem, d: ItemDraft): ItemAnswer => {
  if (d.deferred) return { id: q.id, defer: true };
  const selected: SelectedChoice[] = q.choices
    .filter((c) => d.selectedIds.includes(c.id))
    .map((c) => ({ id: c.id, label: c.label }));
  const custom = d.customText.trim();
  // Multi-select carries the custom row as a selection (it sits alongside the
  // chosen labels); single-choice carries it as `text`, below.
  if (q.multiSelect && d.customSelected && custom.length > 0) {
    selected.push({ label: custom, custom: true });
  }
  // Text rides the answer only where it IS the answer: a free-text question, or
  // a single-choice question answered through the custom row. Sending it beside
  // a chosen label would put two answers in one item.
  const wantsText = q.answerShape === "free_text" || (!q.multiSelect && selected.length === 0);
  const reason = d.reason.trim();
  return {
    id: q.id,
    ...(selected.length > 0 ? { selected } : {}),
    ...(wantsText && custom.length > 0 ? { text: custom } : {}),
    ...(reason.length > 0 ? { reason } : {}),
  };
};

/**
 * Fold the whole draft into the per-item answers the wire takes, through the
 * SERVER's own normalizer. Validating (and posting) the normalized form is what
 * makes the two sides agree on the values themselves: without it the drawer
 * gates on raw draft strings the server would have cleaned first, so a draft of
 * control characters passes here and is refused there.
 */
export const buildItems = (group: QuestionGroup, draft: GroupDraft): readonly ItemAnswer[] =>
  normalizeItemAnswers(group.map((q) => buildItemAnswer(q, draftFor(draft, q.id))));

/** The current draft's validation issues, through the SHARED validator. Empty
 *  means submittable - and means the server will accept it. */
export const draftIssues = (
  group: QuestionGroup,
  draft: GroupDraft,
  context: AnswerContext = {},
): readonly AnswerIssue[] => validateAnswer(group, { items: buildItems(group, draft) }, context);

/** Index of the first question still incomplete, or -1 when the group is ready.
 *  Drives the final tab's "go to incomplete" jump. */
export const firstInvalidIndex = (
  group: QuestionGroup,
  draft: GroupDraft,
  context: AnswerContext = {},
): number => {
  const issues = draftIssues(group, draft, context);
  return group.findIndex((q) => issues.some((i) => i.questionId === q.id));
};

/** Move the active tab, clamped to a real tab. */
export const goToTab = (draft: GroupDraft, index: number, count: number): GroupDraft => {
  const clamped = Math.max(0, Math.min(index, Math.max(0, count - 1)));
  return clamped === draft.activeIndex ? draft : { ...draft, activeIndex: clamped };
};

/** Advance past the current tab, but only when it is complete - so "Next" can
 *  never skip an unanswered question. */
export const advance = (group: QuestionGroup, draft: GroupDraft): GroupDraft => {
  const current = group[draft.activeIndex];
  if (!current) return draft;
  const issues = draftIssues(group, draft);
  if (issues.some((i) => i.questionId === current.id)) return draft;
  return goToTab(draft, draft.activeIndex + 1, group.length);
};

/**
 * The LEGACY answer fields for a question the agent asked the old way (no
 * `group` on the wire): its stored event has no contract to validate items
 * against, so the drawer sends what that wire has always carried - chosen
 * option labels plus free text - rather than an `items` array the server would
 * refuse.
 */
export const legacyAnswerFields = (
  group: QuestionGroup,
  draft: GroupDraft,
): { readonly text: string; readonly options: readonly string[] } => {
  const q = group[0];
  if (!q) return { text: "", options: [] };
  const d = draftFor(draft, q.id);
  const options = q.choices.filter((c) => d.selectedIds.includes(c.id)).map((c) => c.label);
  return { text: d.customSelected ? d.customText.trim() : "", options };
};
