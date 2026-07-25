/**
 * The richer question contract (D12): a group of 1..5 questions, each with
 * structured choices, plus the ONE normalizer and the ONE validator that both
 * sides run - the drawer gates its submit with them, the server re-validates
 * every accept with them. A hand-rolled POST therefore cannot land an answer
 * the UI would have refused, and neither side can drift on what "answered"
 * means.
 *
 * Adapted from Trevor's `ask_user` contract
 * (trevor/packages/session/src/provider-question.ts). Types plus pure
 * coercion/validation only - no transport, no framework, no fs - so the
 * server, the CLI and the browser bundle can all import it.
 *
 * Everything here is ADDITIVE on the existing wire (docs/CONTRACT.md is
 * frozen): the legacy single question (text + options + multi) stays exactly
 * what it was, and normalization folds it into a one-item group so the rich
 * path never needs a second code path for it.
 */

/** How one question is answered: pick exactly one, pick any number, or type. */
export type QuestionAnswerShape = "single_choice" | "multi_select" | "free_text";

/** A group carries at least one and at most five questions (Trevor parity). */
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;

/**
 * Bounds on every model-provided string. The group rides the append-only log,
 * so an unbounded field is a log-size bug as much as a display one; the
 * normalizer clamps rather than rejects, because a truncated label still lets
 * the human answer.
 */
const LIMIT = {
  id: 128,
  label: 200,
  description: 1000,
  question: 2000,
  header: 120,
  impact: 500,
  risk: 500,
  badge: 40,
  badges: 6,
  previewText: 8000,
  previewHtml: 8000,
  choices: 12,
} as const;

/**
 * Bounds on the HUMAN's own words. Unlike the ask-side limits above, these are
 * REJECTED rather than clamped: an agent's over-long label still lets the human
 * answer, but silently clipping their answer changes what they said, and the
 * legacy `text` path never clipped it at all. Normalization therefore keeps one
 * code point past the bound - enough for the validator to see the overflow,
 * still bounded for a payload that never reaches the log.
 */
export const ANSWER_LIMIT = {
  text: 4000,
  reason: 2000,
} as const;

/**
 * Clean an untrusted string: drop C0 controls and DEL, bound the length in CODE
 * POINTS (slicing the joined string could split a surrogate pair). Prose fields
 * keep newlines and tabs; a label or an id does not, because a control
 * character there is only ever noise in a single-line control.
 *
 * Deliberately not `sanitizeAttendant`'s cleaner (events.ts): that one strips
 * every control character including newlines, which is right for a harness id
 * and wrong for a question body.
 */
const clean = (value: unknown, max: number, multiline = false): string => {
  if (typeof value !== "string") return "";
  const kept: string[] = [];
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c === 0x0a || c === 0x09) {
      if (multiline) kept.push(ch);
      continue;
    }
    if (c > 0x1f && c !== 0x7f) kept.push(ch);
  }
  return kept.slice(0, max).join("").trim();
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * A preview attached to a choice. `text` is inert text (Trevor's ASCII mocks);
 * `html` is a wireframe the viewer renders in a script-less sandboxed iframe
 * (D13). Both are MODEL-PROVIDED and never trusted: `html` is carried verbatim
 * and bounded here, and the trust boundary is the sandbox at render time - no
 * consumer may inject it into the chrome's own document.
 */
export interface QuestionPreview {
  readonly text?: string;
  readonly html?: string;
}

/** One selectable choice within a question; `id` and `label` exist after normalization. */
export interface QuestionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly preview?: QuestionPreview;
  /** Pre-selected for single-choice questions only (D12). */
  readonly recommended?: boolean;
  readonly impact?: string;
  readonly risk?: string;
  readonly badges?: readonly string[];
}

/**
 * One question in a group. `answerShape` is DERIVED from `multiSelect` +
 * `choices` and stored, so no consumer re-derives it (and a stored shape is
 * what the validator gates on).
 */
export interface QuestionItem {
  readonly id: string;
  readonly question: string;
  readonly answerShape: QuestionAnswerShape;
  /** Short tab label for the drawer's per-question tabs. */
  readonly header?: string;
  readonly multiSelect: boolean;
  /** The human must give a reason before this question can be submitted. */
  readonly requiresReason: boolean;
  /** This one question may be left unanswered (deferred). */
  readonly allowDefer: boolean;
  readonly choices: readonly QuestionChoice[];
}

/** The normalized group: 1..5 questions once valid. */
export type QuestionGroup = readonly QuestionItem[];

/** A chosen choice (`id` of a real choice), or a typed custom row (`custom`, no `id`). */
export interface SelectedChoice {
  readonly id?: string;
  readonly label: string;
  readonly custom?: boolean;
}

/**
 * The human's answer to ONE question in the group. `selected` carries the
 * chosen choice(s), `text` the typed answer (free text, or the custom row of a
 * choice question), `reason` the justification a `requiresReason` question
 * demands. A deferred question sets `defer` and carries nothing else.
 */
export interface ItemAnswer {
  readonly id: string;
  readonly selected?: readonly SelectedChoice[];
  readonly text?: string;
  readonly reason?: string;
  readonly defer?: boolean;
}

/**
 * A whole-group answer. `skipped` is Lucid's existing decline (the Skip
 * button): like Trevor's `decline` action it short-circuits validation, since
 * declining to answer cannot be malformed.
 */
export interface GroupAnswer {
  readonly items: readonly ItemAnswer[];
  readonly skipped?: boolean;
}

// ---- normalization ---------------------------------------------------------

/** Derive how a question is answered from its multi-select flag and choices. */
export const deriveAnswerShape = (q: {
  readonly multiSelect?: boolean;
  readonly choices?: readonly unknown[];
}): QuestionAnswerShape => {
  if (q.multiSelect) return "multi_select";
  return (q.choices?.length ?? 0) > 0 ? "single_choice" : "free_text";
};

const normalizePreview = (value: unknown): QuestionPreview | undefined => {
  // A bare string is the ASCII/inert-text form (Trevor's shape).
  if (typeof value === "string") {
    const text = clean(value, LIMIT.previewText, true);
    return text.length > 0 ? { text } : undefined;
  }
  const o = record(value);
  if (!o) return undefined;
  const text = clean(o.text, LIMIT.previewText, true);
  const html = clean(o.html, LIMIT.previewHtml, true);
  const preview: QuestionPreview = {
    ...(text.length > 0 ? { text } : {}),
    ...(html.length > 0 ? { html } : {}),
  };
  return text.length > 0 || html.length > 0 ? preview : undefined;
};

const normalizeChoice = (value: unknown, index: number): QuestionChoice => {
  const c = record(value) ?? {};
  const preview = normalizePreview(c.preview);
  const badges = Array.isArray(c.badges)
    ? c.badges
        .map((b) => clean(b, LIMIT.badge))
        .filter((b) => b.length > 0)
        .slice(0, LIMIT.badges)
    : [];
  const description = clean(c.description, LIMIT.description, true);
  const impact = clean(c.impact, LIMIT.impact);
  const risk = clean(c.risk, LIMIT.risk);
  return {
    id: clean(c.id, LIMIT.id) || `choice_${index + 1}`,
    label: clean(c.label, LIMIT.label),
    ...(description.length > 0 ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(c.recommended === true ? { recommended: true } : {}),
    ...(impact.length > 0 ? { impact } : {}),
    ...(risk.length > 0 ? { risk } : {}),
    ...(badges.length > 0 ? { badges } : {}),
  };
};

/** Coerce one raw question (model- or CLI-authored) into a canonical item. */
const normalizeItem = (value: unknown, index: number): QuestionItem => {
  const q = record(value) ?? {};
  // `options` is Lucid's legacy name for `choices`; both read here so the
  // legacy single question needs no separate decoder.
  const rawChoices = Array.isArray(q.choices)
    ? q.choices
    : Array.isArray(q.options)
      ? q.options
      : [];
  const choices = rawChoices.slice(0, LIMIT.choices).map(normalizeChoice);
  const multiSelect = q.multiSelect === true || q.multi === true;
  // ALWAYS derived, never taken from the payload: a caller could otherwise
  // declare "free_text" on a question that ships choices, and the validator
  // (which gates on the shape) and the legacy projection (which gates on
  // multiSelect + choices) would enforce opposite cardinalities. Derivation is
  // idempotent on an already-normalized item, so a re-read still round-trips.
  const answerShape = deriveAnswerShape({ multiSelect, choices });
  const question = clean(q.question ?? q.text, LIMIT.question, true);
  const header = clean(q.header, LIMIT.header);
  return {
    id: clean(q.id, LIMIT.id) || `question_${index + 1}`,
    question,
    answerShape,
    ...(header.length > 0 ? { header } : {}),
    multiSelect,
    requiresReason: q.requiresReason === true,
    allowDefer: q.allowDefer === true,
    choices,
  };
};

/**
 * Normalize a loose raw payload into a canonical group. Three accepted shapes,
 * so callers never pre-shape: a bare array of questions, an object wrapping
 * them (`questions` or `group`), or the LEGACY single question (`question`/
 * `text` + `choices`/`options` + `multi`), which becomes a one-item group.
 *
 * Never throws and never rejects: it always returns a group, and structural
 * validity is `validateGroup`'s separate concern, so a caller can report
 * precise issues while still rendering what it got.
 */
export const normalizeQuestionGroup = (raw: unknown): QuestionGroup => {
  if (Array.isArray(raw)) return raw.map(normalizeItem);
  const o = record(raw);
  if (!o) return [];
  const wrapped = Array.isArray(o.questions)
    ? o.questions
    : Array.isArray(o.group)
      ? o.group
      : undefined;
  if (wrapped) return wrapped.map(normalizeItem);
  // Legacy single form: the whole object IS the question.
  if (typeof o.question === "string" || typeof o.text === "string") {
    return [normalizeItem(o, 0)];
  }
  return [];
};

const normalizeSelected = (value: unknown): readonly SelectedChoice[] => {
  if (!Array.isArray(value)) return [];
  const out: SelectedChoice[] = [];
  const seen = new Set<string>();
  // One PAST the cap: an over-long selection list is validation-significant
  // (an unknown choice, or more than one on a single-choice question), so it
  // must survive normalization to be refused rather than be trimmed to fit.
  for (const raw of value.slice(0, LIMIT.choices + 1)) {
    const s = record(raw);
    if (!s) continue;
    const custom = s.custom === true;
    // A custom row is typed text, not a choice: an id on it would name a
    // choice it is explicitly not one of.
    const id = custom ? "" : clean(s.id, LIMIT.id);
    const label = clean(s.label, LIMIT.label);
    // A selection that names neither a choice nor a label selects nothing -
    // and a blank one would otherwise satisfy "pick one" while summarizing to
    // an empty answer.
    if (id.length === 0 && label.length === 0) continue;
    // Selections are a SET: the same choice twice is one selection, and
    // collapsing here keeps the stored answer and its summary in agreement.
    const key = id.length > 0 ? `id:${id}` : `label:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(id.length > 0 ? { id } : {}),
      label,
      ...(custom ? { custom: true } : {}),
    });
  }
  return out;
};

/** Normalize the untrusted per-item answers of a submitted group answer. */
export const normalizeItemAnswers = (raw: unknown): readonly ItemAnswer[] => {
  if (!Array.isArray(raw)) return [];
  const out: ItemAnswer[] = [];
  // One PAST the group cap. Trimming at the cap would make a sixth answer -
  // which is always either an unknown question or a duplicate - disappear
  // before the validator could refuse it, so an overflowing answer would be
  // accepted as its own first five entries.
  for (const [index, value] of raw.slice(0, MAX_QUESTIONS + 1).entries()) {
    const a = record(value);
    if (!a) continue;
    const id = clean(a.id, LIMIT.id) || `question_${index + 1}`;
    // A deferral carries nothing else: keeping a selection or a reason beside
    // it would contradict the summary, which reads a deferred item as
    // "Deferred" and nothing more.
    if (a.defer === true) {
      out.push({ id, defer: true });
      continue;
    }
    const selected = normalizeSelected(a.selected);
    const text = clean(a.text, ANSWER_LIMIT.text + 1, true);
    const reason = clean(a.reason, ANSWER_LIMIT.reason + 1, true);
    out.push({
      id,
      ...(selected.length > 0 ? { selected } : {}),
      ...(text.length > 0 ? { text } : {}),
      ...(reason.length > 0 ? { reason } : {}),
    });
  }
  return out;
};

// ---- validation ------------------------------------------------------------

export type ContractIssueCode =
  | "no_questions"
  | "too_many_questions"
  | "empty_question"
  | "duplicate_question_id"
  | "missing_choices"
  | "empty_choice_label"
  | "duplicate_choice_id";

export interface ContractIssue {
  readonly code: ContractIssueCode;
  readonly message: string;
  readonly questionId?: string;
}

/**
 * Structural validation of a normalized group: 1..5 questions with unique ids,
 * non-empty question text, choices behind every choice-backed shape, non-empty
 * unique choice ids and labels. The server runs it before appending (a
 * malformed ask is a 400, not a broken drawer); the client may run it to refuse
 * to render a broken group.
 */
export const validateGroup = (group: QuestionGroup): readonly ContractIssue[] => {
  const issues: ContractIssue[] = [];
  if (group.length < MIN_QUESTIONS) {
    issues.push({ code: "no_questions", message: "A question group needs at least one question." });
  }
  if (group.length > MAX_QUESTIONS) {
    issues.push({
      code: "too_many_questions",
      message: `A question group allows at most ${MAX_QUESTIONS} questions, got ${group.length}.`,
    });
  }
  const seenQuestions = new Set<string>();
  for (const q of group) {
    if (q.question.length === 0) {
      issues.push({ code: "empty_question", message: "Question text is empty.", questionId: q.id });
    }
    // Answers are keyed by question id, so a duplicate makes the whole group
    // unanswerable rather than merely untidy.
    if (seenQuestions.has(q.id)) {
      issues.push({
        code: "duplicate_question_id",
        message: `Duplicate question id "${q.id}".`,
        questionId: q.id,
      });
    }
    seenQuestions.add(q.id);
    if (q.answerShape !== "free_text" && q.choices.length === 0) {
      issues.push({
        code: "missing_choices",
        message: `A ${q.answerShape} question needs at least one choice.`,
        questionId: q.id,
      });
    }
    const seenChoices = new Set<string>();
    for (const c of q.choices) {
      if (c.label.length === 0) {
        issues.push({
          code: "empty_choice_label",
          message: "Choice label is empty.",
          questionId: q.id,
        });
      }
      if (seenChoices.has(c.id)) {
        issues.push({
          code: "duplicate_choice_id",
          message: `Duplicate choice id "${c.id}".`,
          questionId: q.id,
        });
      }
      seenChoices.add(c.id);
    }
  }
  return issues;
};

export type AnswerIssueCode =
  | "unknown_question"
  | "duplicate_answer"
  | "unanswered_question"
  | "missing_reason"
  | "missing_selection"
  | "too_many_selected"
  | "unknown_choice"
  | "missing_text"
  | "unexpected_selection"
  | "answer_too_long";

export interface AnswerIssue {
  readonly code: AnswerIssueCode;
  readonly message: string;
  readonly questionId?: string;
}

/**
 * What the answer carries BESIDE its items. A pinned artifact region or an
 * attached image is whole feedback on its own (`src/launch/launcher.ts`), so it
 * answers a free-text question that has no typed words - but only when the
 * group asks ONE question: attachments belong to the answer, not to an item,
 * so with several questions there is nothing to say which one they settle.
 */
export interface AnswerContext {
  readonly hasAttachments?: boolean;
}

/**
 * Validate an answer against the group it answers. A skip is always valid (the
 * human declined; there is nothing to be malformed). Otherwise every question
 * needs an entry matching its stored shape: single_choice takes exactly one
 * selection OR a custom text, multi_select at least one selection (or a custom
 * text), free_text non-empty text and no selections. A deferred question skips
 * its own shape and reason checks, but only where `allowDefer` says it may.
 * Every non-custom selection must name a real choice id.
 */
export const validateAnswer = (
  group: QuestionGroup,
  answer: GroupAnswer,
  context: AnswerContext = {},
): readonly AnswerIssue[] => {
  if (answer.skipped) return [];
  const issues: AnswerIssue[] = [];
  const byId = new Map(answer.items.map((a) => [a.id, a] as const));
  const known = new Set(group.map((q) => q.id));
  const seen = new Set<string>();
  for (const a of answer.items) {
    if (!known.has(a.id)) {
      issues.push({
        code: "unknown_question",
        message: `Answer for unknown question "${a.id}".`,
        questionId: a.id,
      });
    }
    // Two answers to one question: the map above keeps the last, the log keeps
    // both, and the summary would then describe an answer that was not stored.
    if (seen.has(a.id)) {
      issues.push({
        code: "duplicate_answer",
        message: `Question "${a.id}" was answered twice.`,
        questionId: a.id,
      });
    }
    seen.add(a.id);
  }
  for (const q of group) {
    const a = byId.get(q.id);
    if (!a) {
      issues.push({
        code: "unanswered_question",
        message: "Question was not answered.",
        questionId: q.id,
      });
      continue;
    }
    if (a.defer) {
      if (!q.allowDefer) {
        issues.push({
          code: "missing_selection",
          message: "Question cannot be deferred.",
          questionId: q.id,
        });
      }
      continue;
    }
    if (q.requiresReason && (a.reason ?? "").trim().length === 0) {
      issues.push({
        code: "missing_reason",
        message: "A reason is required for this question.",
        questionId: q.id,
      });
    }
    // Code points, matching how the normalizer counts.
    if ([...(a.text ?? "")].length > ANSWER_LIMIT.text) {
      issues.push({
        code: "answer_too_long",
        message: `An answer is at most ${ANSWER_LIMIT.text} characters.`,
        questionId: q.id,
      });
    }
    if ([...(a.reason ?? "")].length > ANSWER_LIMIT.reason) {
      issues.push({
        code: "answer_too_long",
        message: `A reason is at most ${ANSWER_LIMIT.reason} characters.`,
        questionId: q.id,
      });
    }
    const selected = a.selected ?? [];
    const validIds = new Set(q.choices.map((c) => c.id));
    for (const sel of selected) {
      if (!sel.custom && (sel.id === undefined || !validIds.has(sel.id))) {
        issues.push({
          code: "unknown_choice",
          message: `Selected choice "${sel.id ?? sel.label}" is not in this question.`,
          questionId: q.id,
        });
      }
    }
    const hasText = (a.text ?? "").trim().length > 0;
    if (q.answerShape === "single_choice") {
      if (selected.length === 0 && !hasText) {
        issues.push({
          code: "missing_selection",
          message: "Pick one choice or enter a custom answer.",
          questionId: q.id,
        });
      }
      if (selected.length > 1) {
        issues.push({
          code: "too_many_selected",
          message: "Only one choice may be selected.",
          questionId: q.id,
        });
      }
    } else if (q.answerShape === "multi_select") {
      if (selected.length === 0 && !hasText) {
        issues.push({
          code: "missing_selection",
          message: "Select at least one choice.",
          questionId: q.id,
        });
      }
    } else {
      // A pinned region or an image is the answer where there is exactly one
      // question to answer: pointing at the artifact says as much as typing.
      const answeredByAttachment = context.hasAttachments === true && group.length === 1;
      if (!hasText && !answeredByAttachment) {
        issues.push({
          code: "missing_text",
          message: "Enter an answer, pin a spot, or attach an image.",
          questionId: q.id,
        });
      }
      if (selected.length > 0) {
        issues.push({
          code: "unexpected_selection",
          message: "A free-text question takes no choices.",
          questionId: q.id,
        });
      }
    }
  }
  return issues;
};

// ---- summaries + legacy projection ----------------------------------------

/** One question's answer as a human (and agent) reads it. */
export const summarizeItemAnswer = (item: QuestionItem, answer: ItemAnswer): string => {
  if (answer.defer) return "Deferred";
  const labels: string[] = [];
  for (const sel of answer.selected ?? []) {
    // Prefer the contract's own label over the submitted one: the choice text
    // the agent wrote is what it should read back, not a client's copy of it.
    const known = sel.id ? item.choices.find((c) => c.id === sel.id) : undefined;
    const label = known?.label ?? sel.label;
    if (label.length > 0) labels.push(label);
  }
  const text = (answer.text ?? "").trim();
  if (text.length > 0 && !labels.includes(text)) labels.push(text);
  const body = labels.join(", ");
  const reason = (answer.reason ?? "").trim();
  return reason.length > 0 ? `${body} (reason: ${reason})` : body;
};

/**
 * The whole group's answer as one readable line - the field an agent reads
 * without walking `items` (Trevor's `ProviderQuestionAccept.answer`).
 *
 * Derived, never stored on the answer event: a stored summary can disagree with
 * the group it summarizes, and this one cannot. Multi-question groups name each
 * question, because bare labels ("Postgres; later") lose which decision they
 * settled - the one place this departs from Trevor's plain "; " join.
 */
export const summarizeAnswer = (group: QuestionGroup, items: readonly ItemAnswer[]): string => {
  const byId = new Map(items.map((a) => [a.id, a] as const));
  const parts: string[] = [];
  for (const q of group) {
    const a = byId.get(q.id);
    if (!a) continue;
    const summary = summarizeItemAnswer(q, a);
    if (summary.length === 0) continue;
    parts.push(group.length > 1 ? `${q.header || q.question} -> ${summary}` : summary);
  }
  return parts.join("; ");
};

/**
 * Project a LEGACY answer (free text plus chosen option labels) onto the
 * grouped shape - the inverse of `legacyProjection`, for the one case where
 * the two are the same question: a ONE-item group, which a legacy consumer was
 * shown losslessly and can therefore answer losslessly. A client that predates
 * the drawer keeps working instead of having its answer refused, and its answer
 * still goes through the one validator. Undefined when the group is not
 * projectable (more than one question), which is a real refusal.
 */
export const projectLegacyAnswer = (
  group: QuestionGroup,
  legacy: { readonly text?: string; readonly options?: readonly string[] },
): readonly ItemAnswer[] | undefined => {
  const item = group.length === 1 ? group[0] : undefined;
  if (!item) return undefined;
  const selected: SelectedChoice[] = [];
  for (const label of legacy.options ?? []) {
    // The legacy wire carries labels, not ids; an unmatched label is what the
    // old panel's "Other" row produces, which is exactly a custom selection.
    const choice = item.choices.find((c) => c.label === label);
    selected.push(choice ? { id: choice.id, label: choice.label } : { label, custom: true });
  }
  const text = (legacy.text ?? "").trim();
  return [
    {
      id: item.id,
      ...(selected.length > 0 ? { selected } : {}),
      ...(text.length > 0 ? { text } : {}),
    },
  ];
};

/** The legacy single-question fields of a `question` event (text/options/multi). */
export interface LegacyQuestionFields {
  readonly text: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multi?: true;
}

/**
 * Project a rich group onto the legacy fields every existing consumer already
 * reads. The rich `group` is additive, so a viewer or agent that knows nothing
 * about it still sees a usable question instead of an empty card; a one-item
 * group projects losslessly, and a larger one keeps the first question plus a
 * count so the text never pretends to be the whole ask.
 */
export const legacyProjection = (group: QuestionGroup): LegacyQuestionFields => {
  const first = group[0];
  if (!first) return { text: "" };
  if (group.length > 1) {
    return { text: `${first.question} (+${group.length - 1} more)` };
  }
  const options = first.choices
    .filter((c) => c.label.length > 0)
    .map((c) => ({ label: c.label, ...(c.description ? { description: c.description } : {}) }));
  return {
    text: first.question,
    ...(options.length > 0 ? { options } : {}),
    ...(first.multiSelect && options.length > 0 ? { multi: true as const } : {}),
  };
};
