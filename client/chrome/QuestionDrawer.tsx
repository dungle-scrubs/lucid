import { useEffect, useMemo, useRef, useState } from "react";
import type {
  QuestionChoice,
  QuestionGroup,
  QuestionItem,
  QuestionPreview,
} from "../../src/core/question-contract.ts";
import { useActions, useSession } from "./context.tsx";
import {
  advance,
  draftFor,
  draftIssues,
  firstInvalidIndex,
  type GroupDraft,
  goToTab,
  groupOf,
  initialDraft,
  selectCustom,
  setCustomText,
  setReason,
  toggleChoice,
  toggleDefer,
} from "./question-draft.ts";
import type { AgentQuestion } from "./types.ts";
import { Kbd } from "./ui/kbd.tsx";
import { Markdown } from "./ui/markdown.tsx";
import { closeButton, closeButtonSmall } from "./ui/close.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * The question drawer (D11-D13): a pending ask slides up from the bottom of the
 * SURFACE, not into the transcript. The artifact stays live above it - a pick
 * up there attaches to this answer - and lowering the drawer keeps every draft,
 * because the draft lives in the session store.
 *
 * Height is AUTO: the drawer rises exactly as far as its content needs and
 * scrolls internally only past a cap, so it never takes artifact space it has
 * no use for.
 *
 * Model-provided text is never trusted with markup: a string preview renders as
 * inert `<pre>`, an HTML wireframe renders in a script-less sandboxed iframe.
 */

/** Short, human excerpt of a pinned region for the chip - the anchor's snippet
 *  is outerHTML, so strip tags and clip. */
const anchorLabel = (snippet: string): string => {
  const text = snippet
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text || "pinned region";
};

/** How many questions the human still owes, counting a grouped ask as its
 *  questions rather than as one - that number is what the reopen bar promises. */
const pendingCount = (open: readonly AgentQuestion[]): number =>
  open.reduce((n, q) => n + Math.max(1, q.group?.length ?? 0), 0);

/**
 * The drawer's state, shared with the surface it overlays: SessionView reads
 * `raised` to parallax the artifact up, and only this hook decides what raised
 * means. The oldest outstanding ask is the one on screen; answering it raises
 * the next.
 */
export const useQuestionDrawer = (): {
  readonly current: AgentQuestion | undefined;
  readonly pending: number;
  readonly raised: boolean;
} => {
  const questions = useSession((s) => s.questions);
  const dismissed = useSession((s) => s.questionDrawerDismissed);
  const open = questions.filter((q) => !q.answered);
  const current = open[0];
  return {
    current,
    pending: pendingCount(open),
    // A dismissal covers only the asks it was made against: an ask that was NOT
    // outstanding at the time raises the drawer again, because lowering one is
    // not a standing refusal to be asked.
    raised: open.some((q) => !dismissed.includes(q.id)),
  };
};

/** Every draft edit is a REDUCER, never a computed value: two edits in one tick
 *  (a click that also blurs a field) must compose instead of the later one
 *  overwriting a snapshot the earlier one already moved past. */
type DraftUpdate = (draft: GroupDraft) => GroupDraft;

const FIELD =
  "w-full resize-y border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline";

/** Move focus to the panel's active target: the tabbable choice row, or the
 *  first field on a free-text question. */
const focusPanel = (root: HTMLElement | null): void => {
  const target =
    root?.querySelector<HTMLElement>('[data-qrow][tabindex="0"]') ??
    root?.querySelector<HTMLElement>("textarea, input");
  target?.focus();
};

/**
 * Wrap a model-authored wireframe in a document that can only draw itself. The
 * empty sandbox stops scripts, forms and same-origin access, but it does NOT
 * stop the NETWORK: a bare `<img src>` or `<link rel=stylesheet>` in the model's
 * markup would issue a remote (or loopback) GET the moment the frame paints.
 * The CSP is the first element in the head, so nothing the model wrote can
 * loosen it, and the two directives left open (inline styles, data: images) are
 * exactly what a self-contained wireframe needs.
 */
const previewDocument = (html: string): string =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;

/** A choice's preview. A string is inert text; `html` is a MODEL-AUTHORED
 *  wireframe, so it renders in an iframe with an EMPTY sandbox allowlist - no
 *  scripts, no same-origin, no forms - under a network-less CSP, which is the
 *  only reason it may be rendered as markup at all (D13). */
const ChoicePreview = ({
  preview,
  label,
}: {
  readonly preview: QuestionPreview;
  readonly label: string;
}) => (
  <div className="flex min-w-0 flex-col gap-1">
    {preview.html ? (
      <iframe
        data-test="preview-frame"
        title={`Preview: ${label}`}
        srcDoc={previewDocument(preview.html)}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-[200px] w-full border border-ink-600 bg-surface"
      />
    ) : null}
    {preview.text ? (
      <pre
        data-test="preview-text"
        className="overflow-x-auto border border-ink-600 bg-bg-inset p-2 font-mono text-[11px] leading-snug text-fg-muted"
      >
        {preview.text}
      </pre>
    ) : null}
  </div>
);

/**
 * The detail pane: every preview stacked into ONE grid cell so the pane is
 * sized to the tallest and never reflows as the highlighted option changes;
 * only the active one is visible.
 *
 * Rendered ONCE at every width - beside the choices when wide, under them when
 * narrow. A second, responsively-hidden copy would instantiate every choice's
 * frame twice (24 of them at the 12-choice cap) and make `preview-frame`
 * ambiguous to anything selecting it.
 */
const PreviewPane = ({
  choices,
  activeId,
}: {
  readonly choices: readonly QuestionChoice[];
  readonly activeId: string;
}) => {
  const withPreview = choices.filter((c) => c.preview);
  if (withPreview.length === 0) return null;
  return (
    <div className="grid min-w-0">
      {withPreview.map((c) => (
        <figure
          key={c.id}
          aria-hidden={c.id !== activeId}
          // min-w-0: without it a wide preview grows the column past the drawer
          // edge instead of scrolling inside its own box.
          className="m-0 flex min-w-0 flex-col gap-1 [grid-area:1/1]"
          style={{ visibility: c.id === activeId ? "visible" : "hidden" }}
        >
          {c.preview ? <ChoicePreview preview={c.preview} label={c.label} /> : null}
          <figcaption className="text-[11px] text-fg-faint">{c.label}</figcaption>
        </figure>
      ))}
    </div>
  );
};

const Indicator = ({ multi, on }: { readonly multi: boolean; readonly on: boolean }) => (
  <span
    aria-hidden
    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border text-[10px] ${
      multi ? "" : ""
    } ${on ? "border-accent bg-accent text-on-accent" : "border-ink-400 text-transparent"}`}
  >
    ✓
  </span>
);

/** One choice row: numbered so an answer can be given by number, with its
 *  metadata and (narrow layout only) its own preview. */
const ChoiceRow = ({
  choice,
  index,
  multi,
  selected,
  active,
  tabIndex,
  onSelect,
  onActivate,
  onKeyNav,
}: {
  readonly choice: QuestionChoice;
  readonly index: number;
  readonly multi: boolean;
  readonly selected: boolean;
  readonly active: boolean;
  readonly tabIndex: number;
  readonly onSelect: () => void;
  readonly onActivate: () => void;
  readonly onKeyNav: (e: React.KeyboardEvent) => void;
}) => (
  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is valid on radio and checkbox alike; the ternary role defeats the static check.
  <button
    type="button"
    role={multi ? "checkbox" : "radio"}
    data-test="choice"
    data-qrow={index}
    data-choice-id={choice.id}
    aria-checked={selected}
    tabIndex={tabIndex}
    onClick={onSelect}
    onFocus={onActivate}
    onMouseEnter={onActivate}
    onKeyDown={onKeyNav}
    className={`flex w-full cursor-pointer items-start gap-2.5 border px-2.5 py-1.5 text-left ${
      selected
        ? "border-accent bg-accent/15"
        : active
          ? "border-ink-400 bg-ink-700"
          : "border-ink-600 bg-bg-inset hover:border-ink-400"
    }`}
  >
    <Indicator multi={multi} on={selected} />
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-medium text-fg">
          <span className="tabular-nums text-fg-faint">{index + 1}.</span> {choice.label}
        </span>
        {choice.recommended ? (
          <span className="border border-accent/50 bg-accent/10 px-1.5 text-[10px] text-accent-bright">
            Recommended
          </span>
        ) : null}
        {(choice.badges ?? []).map((b) => (
          <span key={b} className="border border-ink-500 px-1.5 text-[10px] text-fg-muted">
            {b}
          </span>
        ))}
      </span>
      {choice.description ? (
        <span className="text-[11px] text-fg-muted">{choice.description}</span>
      ) : null}
      {choice.impact ? (
        <span className="text-[11px] text-fg-muted">
          <span className="text-fg">Impact:</span> {choice.impact}
        </span>
      ) : null}
      {choice.risk ? (
        <span className="text-[11px] text-rust-300">
          <span className="font-medium">Risk:</span> {choice.risk}
        </span>
      ) : null}
    </span>
  </button>
);

/** The custom ("Other") row every choice question gets. TYPING selects it -
 *  focus alone must never steal a selection, or a stray click on this
 *  full-width row would silently clear a required single choice. */
const CustomRow = ({
  item,
  draft,
  index,
  tabIndex,
  onChange,
  onActivate,
  onKeyNav,
}: {
  readonly item: QuestionItem;
  readonly draft: GroupDraft;
  readonly index: number;
  readonly tabIndex: number;
  readonly onChange: (update: DraftUpdate) => void;
  readonly onActivate: () => void;
  readonly onKeyNav: (e: React.KeyboardEvent) => void;
}) => {
  const d = draftFor(draft, item.id);
  return (
    // A label, so a click anywhere in the row focuses the field natively.
    <label
      className={`flex w-full cursor-pointer items-start gap-2.5 border px-2.5 py-1.5 ${
        d.customSelected ? "border-accent bg-accent/15" : "border-ink-600 bg-bg-inset"
      }`}
    >
      <Indicator multi={item.multiSelect} on={d.customSelected} />
      <textarea
        rows={1}
        data-test="custom-answer"
        data-qrow={index}
        data-custom-answer
        tabIndex={tabIndex}
        aria-label={`Your own answer for: ${item.question}`}
        value={d.customText}
        onChange={(e) => {
          const text = e.target.value;
          onChange((d0) => setCustomText(d0, item, text));
        }}
        onFocus={onActivate}
        onKeyDown={onKeyNav}
        placeholder={item.multiSelect ? "Add your own option…" : "Or write your own answer…"}
        className="min-w-0 flex-1 resize-none bg-transparent font-sans text-[13px] text-fg outline-none [field-sizing:content] placeholder:text-fg-faint"
      />
    </label>
  );
};

/**
 * The single-choice radio keyboard pattern with the custom row as the last
 * item: Up/Down (and Home/End) move BOTH the selection and focus. Left/Right
 * are deliberately absent so they reach the drawer's tab navigation.
 */
const makeChoiceNav =
  (item: QuestionItem, onChange: (update: DraftUpdate) => void) =>
  (e: React.KeyboardEvent, current: number): void => {
    if (item.multiSelect) return;
    const customIndex = item.choices.length;
    const focusRow = (target: number): void => {
      const group = e.currentTarget.closest("[data-qgroup]");
      group?.querySelector<HTMLElement>(`[data-qrow="${target}"]`)?.focus();
    };
    if (current === customIndex) {
      // The custom row is a text field: arrows move the caret. Only ArrowUp at
      // the very start leaves it.
      const el = e.target as HTMLTextAreaElement;
      if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
        const target = customIndex - 1;
        const c = item.choices[target];
        if (!c) return;
        e.preventDefault();
        onChange((d) => toggleChoice(d, item, c.id));
        focusRow(target);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? customIndex
          : e.key === "ArrowDown"
            ? Math.min(current + 1, customIndex)
            : Math.max(current - 1, 0);
    if (target === current) return;
    const c = item.choices[target];
    onChange((d) => (c ? toggleChoice(d, item, c.id) : selectCustom(d, item)));
    focusRow(target);
  };

/** Only the selected radio (or the first, when nothing is picked) is tabbable;
 *  multi-select rows are all ordinary tab stops. */
const tabIndexFor = (item: QuestionItem, draft: GroupDraft, index: number): number => {
  if (item.multiSelect) return 0;
  const d = draftFor(draft, item.id);
  const customIndex = item.choices.length;
  if (index === customIndex) return d.customSelected ? 0 : -1;
  if (d.customSelected) return -1;
  const id = item.choices[index]?.id ?? "";
  return d.selectedIds.includes(id) || (d.selectedIds.length === 0 && index === 0) ? 0 : -1;
};

/**
 * The question itself, in the agent's Markdown (#40) - paragraphs, lists, and
 * fenced code render as themselves, the same treatment the transcript gives
 * agent prose. No clamp: the reader always needs the whole question before
 * answering, so a disclosure was a step they took every time. The drawer's
 * own 60% cap with internal scroll is the height governor for true walls.
 */
const QuestionText = ({ text }: { readonly text: string }) => (
  <div data-test="question-text">
    <Markdown text={text} />
  </div>
);

/** One question: its choices (or a free-text field), the required reason, and
 *  its own defer. */
const QuestionCard = ({
  item,
  draft,
  onChange,
}: {
  readonly item: QuestionItem;
  readonly draft: GroupDraft;
  readonly onChange: (update: DraftUpdate) => void;
}) => {
  const d = draftFor(draft, item.id);
  const split = item.choices.some((c) => c.preview);
  // The detail pane opens on the recommended choice (or the first) and then
  // follows focus and hover.
  const [activeId, setActiveId] = useState(
    () => (item.choices.find((c) => c.recommended) ?? item.choices[0])?.id ?? "",
  );
  const nav = makeChoiceNav(item, onChange);

  const column = (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is valid on group and radiogroup alike; the ternary role defeats the static check.
    <div
      data-qgroup
      role={item.multiSelect ? "group" : "radiogroup"}
      aria-label={item.question}
      className="flex min-w-0 flex-col gap-1.5"
    >
      {item.choices.map((c, i) => (
        <ChoiceRow
          key={c.id}
          choice={c}
          index={i}
          multi={item.multiSelect}
          selected={d.selectedIds.includes(c.id)}
          active={split && c.id === activeId}
          tabIndex={tabIndexFor(item, draft, i)}
          onSelect={() => {
            onChange((d0) => toggleChoice(d0, item, c.id));
            setActiveId(c.id);
          }}
          onActivate={() => setActiveId(c.id)}
          onKeyNav={(e) => nav(e, i)}
        />
      ))}
      <CustomRow
        item={item}
        draft={draft}
        index={item.choices.length}
        tabIndex={tabIndexFor(item, draft, item.choices.length)}
        onChange={onChange}
        onActivate={() => setActiveId("")}
        onKeyNav={(e) => nav(e, item.choices.length)}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-2" data-test="question" data-question-item={item.id}>
      <QuestionText text={item.question} />
      <div className={d.deferred ? "flex flex-col gap-1.5 opacity-50" : "flex flex-col gap-1.5"}>
        {item.answerShape === "free_text" ? (
          <textarea
            rows={3}
            data-test="free-text"
            aria-label={item.question}
            value={d.customText}
            onChange={(e) => {
              const text = e.target.value;
              onChange((d0) => setCustomText(d0, item, text));
            }}
            placeholder="Your answer…"
            className={FIELD}
          />
        ) : split ? (
          // The @container must be an ANCESTOR of the grid: an element cannot
          // size itself by its own width, only its descendants can.
          <div className="@container">
            <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1.5 @lg:grid-cols-2">
              {column}
              <PreviewPane choices={item.choices} activeId={activeId} />
            </div>
          </div>
        ) : (
          column
        )}

        {item.requiresReason ? (
          <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
            <span>
              Reason <span className="text-rust-300">*</span>
            </span>
            <textarea
              rows={2}
              data-test="reason"
              value={d.reason}
              onChange={(e) => {
                const reason = e.target.value;
                onChange((d0) => setReason(d0, item.id, reason));
              }}
              placeholder="Why this choice?"
              className={FIELD}
            />
          </label>
        ) : null}
      </div>
      {item.allowDefer ? (
        <button
          type="button"
          data-test="defer"
          aria-pressed={d.deferred}
          onClick={() => onChange((d0) => toggleDefer(d0, item.id))}
          className={`w-fit cursor-pointer text-[11px] underline-offset-2 hover:underline ${
            d.deferred ? "text-fg" : "text-fg-faint hover:text-fg-muted"
          }`}
        >
          {d.deferred ? "Deferred - answer it instead" : "Defer this one"}
        </button>
      ) : null}
    </div>
  );
};

/** The pinned region and images the answer carries - the same materials as an
 *  annotation, gathered onto the answer instead. */
const AnswerAttachments = ({ q }: { readonly q: AgentQuestion }) => {
  const {
    addAnswerImage,
    cancelAnswerPick,
    removeAnswerAnchor,
    removeAnswerImage,
    startAnswerPick,
  } = useActions();
  const anchors = useSession((s) => s.answerAnchorLists[q.id]);
  const images = useSession((s) => s.answerImages[q.id]);
  const picking = useSession((s) => s.answerPickFor === q.id);
  const pins = anchors ?? [];
  const imgs = images ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* One chip per pinned spot (shift+⌘-click collects several); the ×
          drops that spot alone, and dropping the last clears the pin. */}
      {pins.map((anchor, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: anchors have no id and the list only ever shrinks from a fixed pick order.
          key={i}
          data-test="answer-anchor"
          className="inline-flex items-center gap-1 border border-accent/50 bg-accent/10 px-2 py-px text-[11px] text-fg"
        >
          <span className="text-accent-bright">◎</span>
          {anchorLabel(anchor.snippet)}
          <button
            type="button"
            aria-label="Remove pinned region"
            onClick={() => removeAnswerAnchor(q, i)}
            className={closeButtonSmall}
          >
            ×
          </button>
        </span>
      ))}
      {pins.length === 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-test="pin-region"
                onClick={() => (picking ? cancelAnswerPick() : startAnswerPick(q))}
                className={`inline-flex cursor-pointer items-center gap-1 border px-2 py-px text-[11px] ${
                  picking
                    ? "border-accent-bright bg-ink-700 text-accent-bright"
                    : "border-ink-400 text-fg-muted hover:border-accent-bright hover:text-fg"
                }`}
              >
                {picking ? "Click a spot in the artifact · Esc to cancel" : "◎ Pin a spot"}
              </button>
            }
          />
          <TooltipContent>
            Or shift-click the artifact - shift+⌘-click pins several spots
          </TooltipContent>
        </Tooltip>
      ) : null}
      <label className="inline-flex cursor-pointer items-center gap-1 border border-ink-400 px-2 py-px text-[11px] text-fg-muted hover:border-accent-bright hover:text-fg">
        Attach image
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            for (const f of files) void addAnswerImage(q, f);
            e.target.value = "";
          }}
        />
      </label>
      {imgs.map((img) => (
        <span key={img.id} className="relative inline-block">
          <img
            src={img.url}
            alt={img.name}
            className="h-10 w-10 border border-ink-600 object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${img.name}`}
            onClick={() => removeAnswerImage(q, img.id)}
            className="absolute -right-2 -top-2 flex size-5 cursor-pointer items-center justify-center border border-ink-400 bg-ink-850 text-[12px] leading-none text-fg-muted hover:text-fg focus-visible:annot-outline"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
};

/** The raised drawer for ONE asked question. Keyed on the question id by its
 *  parent, so a new ask gets a fresh panel (and a fresh slide-up) rather than
 *  inheriting the last one's transient state. */
const Drawer = ({
  q,
  group,
  pending,
  animate,
}: {
  readonly q: AgentQuestion;
  readonly group: QuestionGroup;
  readonly pending: number;
  /** False when a drawer was already up: swap content, do not re-slide. */
  readonly animate: boolean;
}) => {
  const {
    dismissQuestionDrawer,
    focusQuestionRef,
    reaskQuestion,
    skipQuestion,
    submitAnswer,
    updateQuestionDraft,
  } = useActions();
  const stored = useSession((s) => s.questionDrafts[q.id]);
  const uploading = useSession((s) => (s.answerUploading[q.id] ?? 0) > 0);
  // A pinned region or an attached image is itself an answer to a single
  // free-text ask, so the submit gate has to know about them (the shared
  // validator decides where they count).
  const hasAttachments = useSession(
    (s) => s.answerAnchors[q.id] !== undefined || (s.answerImages[q.id]?.length ?? 0) > 0,
  );
  const seeded = useMemo(() => initialDraft(group), [group]);
  const draft = stored ?? seeded;
  const onChange = (update: DraftUpdate): void => updateQuestionDraft(q, update);

  const issues = draftIssues(group, draft, { hasAttachments });
  const grouped = group.length > 1;
  const activeIndex = Math.min(draft.activeIndex, group.length - 1);
  const item = group[activeIndex];
  const isFinal = activeIndex >= group.length - 1;
  const tabIssue = item ? issues.find((i) => i.questionId === item.id) : undefined;
  const tabValid = tabIssue === undefined;
  const ready = issues.length === 0 && !uploading;
  const firstInvalid = firstInvalidIndex(group, draft, { hasAttachments });

  // Slide up on ARRIVAL only. The component remounts per question (key), but
  // between consecutive questions the drawer must stay up and just swap its
  // content - the drawer itself is the state, and a full down-and-up between
  // tests read as the UI losing its place. `animate` is false whenever a
  // drawer was already showing.
  const [shown, setShown] = useState(!animate);
  useEffect(() => {
    if (shown) return;
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [shown]);

  // Focus follows a TAB CHANGE, never the drawer's arrival: a question landing
  // while the human types in the composer must not steal their caret.
  const panelRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIndex is the deliberate trigger - the effect refocuses the panel the tab change just swapped in, and reads only the (stable) refs.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    focusPanel(panelRef.current);
  }, [activeIndex]);

  const submit = (): void => {
    if (ready) void submitAnswer(q);
  };

  // The primary action: submit on the final (or only) question, otherwise
  // confirm-and-advance. `advance` refuses an incomplete tab, so this can never
  // skip an unanswered question.
  const confirmOrAdvance = (): void => {
    if (isFinal) submit();
    else onChange((d) => advance(group, d));
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const el = e.target as HTMLElement;
    const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    if (grouped && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (typing) return; // the caret keeps moving inside a field
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      onChange((d) => goToTab(d, activeIndex + delta, group.length));
      return;
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    // Enter must keep ACTIVATING whatever button it is pressed on - Skip,
    // Defer, a tab, the lower button. Only a choice row (`data-qrow`, whose own
    // activation is Space) hands Enter on to the drawer, so that an answer made
    // of selections alone can be sent from the keyboard. Without this, Enter on
    // Skip recorded the drawer's draft as the human's decision instead of
    // declining.
    if (el.closest("button, a, summary") && !el.closest("[data-qrow]")) return;
    // Inside a multi-line field Enter stays a newline unless modified - except
    // the custom-answer row, whose whole content is one short answer, so Enter
    // confirms there and Shift+Enter is the newline.
    const custom = typing && el.hasAttribute("data-custom-answer");
    if (e.metaKey || e.ctrlKey || ((!typing || custom) && !e.shiftKey)) {
      e.preventDefault();
      confirmOrAdvance();
    }
  };

  return (
    <section
      data-test="question-drawer"
      aria-label="Question from the agent"
      onKeyDown={onKeyDown}
      // Auto height, capped: the drawer rises only as far as its content needs
      // and scrolls inside itself past 60% of the surface, so it never hogs
      // artifact space (D11).
      className={`absolute inset-x-0 bottom-0 z-20 max-h-[60%] overflow-y-auto border-t border-accent/40 bg-ink-850 shadow-[0_-8px_30px_rgba(0,0,0,0.45)] transition-transform duration-200 ease-out ${
        shown ? "translate-y-0" : "translate-y-full"
      }`}
    >
      <div className="flex flex-col gap-2.5 p-[12px_14px_14px]">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-accent-bright">
            {grouped ? `Question ${activeIndex + 1} of ${group.length}` : "Question for you"}
          </span>
          {pending > group.length ? (
            <span className="text-[10px] text-fg-faint">{pending} waiting</span>
          ) : null}
          {q.ref ? (
            <button
              type="button"
              data-test="question-ref"
              onClick={() => focusQuestionRef(q.ref)}
              className="cursor-pointer text-[11px] text-accent-bright underline-offset-2 hover:underline"
            >
              Show me where
            </button>
          ) : null}
          <span className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-test="drawer-lower"
                  aria-label="Lower the question drawer"
                  onClick={() => dismissQuestionDrawer()}
                  className={closeButton}
                >
                  ×
                </button>
              }
            />
            <TooltipContent>Lower the drawer (Esc) - your draft is kept</TooltipContent>
          </Tooltip>
        </div>

        {grouped ? (
          // Hand-rolled rather than the vendored Tabs: activation must be
          // MANUAL (a trigger firing on focus would answer-by-arrowing), and
          // these tabs carry per-question validity, which is ours to compute.
          <div role="tablist" aria-label="Questions" className="flex flex-wrap gap-1">
            {group.map((g, i) => {
              const valid = !issues.some((issue) => issue.questionId === g.id);
              const on = i === activeIndex;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  data-test="question-tab"
                  data-answered={valid ? "true" : "false"}
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => onChange((d) => goToTab(d, i, group.length))}
                  className={`flex max-w-[16rem] cursor-pointer items-center gap-1 border px-2 py-1 text-[11px] ${
                    on
                      ? "border-accent bg-accent/15 text-fg"
                      : "border-ink-600 bg-bg-inset text-fg-muted hover:border-ink-400"
                  }`}
                >
                  <span className="min-w-0 truncate">{g.header || `Question ${i + 1}`}</span>
                  {valid ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span role="img" aria-label="answered" className="text-accent-bright">
                            ✓
                          </span>
                        }
                      />
                      <TooltipContent>answered</TooltipContent>
                    </Tooltip>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Only the active question renders, keyed so one question's transient
            state (the preview pane's highlight) never leaks into the next. */}
        <div ref={panelRef}>
          {item ? (
            <QuestionCard key={item.id} item={item} draft={draft} onChange={onChange} />
          ) : null}
        </div>

        <AnswerAttachments q={q} />

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-test="answer"
            // Next needs only THIS question settled; Submit needs the whole
            // group. Gating Next on the group would make a three-question ask
            // unanswerable - you could never reach the questions it waits on.
            disabled={uploading || (isFinal ? !ready : !tabValid)}
            onClick={confirmOrAdvance}
            className="flex w-fit cursor-pointer items-center gap-1.5 border border-accent bg-accent px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-on-accent hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading
              ? "Uploading…"
              : grouped && !isFinal
                ? "Next"
                : grouped
                  ? "Submit answers"
                  : "Answer"}
            <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
          </button>
          {/* A disabled submit with no way forward is a dead end: on the final
              tab, name the question that is still incomplete and go there. It
              is named the way its TAB is, so the button points at something the
              human can see. */}
          {grouped && isFinal && firstInvalid >= 0 ? (
            <button
              type="button"
              data-test="goto-incomplete"
              onClick={() => onChange((d) => goToTab(d, firstInvalid, group.length))}
              className="w-fit max-w-[16rem] cursor-pointer truncate border border-ink-500 px-2 py-[3px] text-[11px] text-fg-muted hover:border-accent-bright hover:text-fg"
            >
              Go to {group[firstInvalid]?.header || `Question ${firstInvalid + 1}`}
            </button>
          ) : null}
          {/* Why the button is dead. A disabled submit with no stated reason
              was the whole complaint about the old panel's silent refusals. */}
          {!tabValid && !uploading ? (
            <span data-test="answer-blocked" className="text-[11px] text-fg-faint">
              {tabIssue?.message}
            </span>
          ) : null}
          <span className="flex-1" />
          {/* "I don't understand" (#40): clears the ask with unclear:true so
              the agent re-asks the SAME thing shorter and plainer. Whatever
              was typed on the current question rides along as the note saying
              what was confusing. */}
          <button
            type="button"
            data-test="reask"
            onClick={() => {
              // Only LIVE typing rides as the confusion note: custom text
              // behind an unselected "Other" row is a discarded draft, not
              // what the human found unclear. A grouped ask names the item,
              // so the agent knows which subquestion to re-ask plainly.
              const active = group[draft.activeIndex];
              const d = active ? draft.byId[active.id] : undefined;
              const live = active && d && (active.answerShape === "free_text" || d.customSelected);
              const raw = live ? d.customText.trim() : "";
              const note =
                raw && active && group.length > 1
                  ? `${active.header || `Question ${draft.activeIndex + 1}`}: ${raw}`
                  : raw;
              void reaskQuestion(q, note);
            }}
            className="w-fit cursor-pointer text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
          >
            Re-ask
          </button>
          {/* Decline the whole ask: the agent is told to proceed without an
              answer rather than re-asking. */}
          <button
            type="button"
            data-test="skip"
            onClick={() => void skipQuestion(q)}
            className="w-fit cursor-pointer text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
          >
            Skip
          </button>
        </div>
      </div>
    </section>
  );
};

/** The lowered drawer's trace: a slim bar naming what is still owed. A drawer
 *  the human lowered must never become an invisible obligation. */
const ReopenBar = ({ pending }: { readonly pending: number }) => {
  const { raiseQuestionDrawer } = useActions();
  return (
    <button
      type="button"
      data-test="question-reopen"
      onClick={raiseQuestionDrawer}
      className="absolute inset-x-0 bottom-0 z-20 flex cursor-pointer items-center justify-center gap-2 border-t border-accent/40 bg-ink-850 py-1.5 text-[11px] text-accent-bright hover:bg-ink-800"
    >
      <span aria-hidden>▲</span>
      {pending === 1 ? "1 question waiting" : `${pending} questions waiting`}
    </button>
  );
};

/**
 * The drawer as SessionView mounts it: over the surface region, so it overlays
 * the artifact and never the review panel. Renders nothing while no question is
 * outstanding.
 */
export const QuestionDrawer = () => {
  const { current, pending, raised } = useQuestionDrawer();
  const { cancelAnswerPick, dismissQuestionDrawer } = useActions();
  const picking = useSession((s) => s.answerPickFor);
  const diffMode = useSession((s) => s.diffMode);
  const lightbox = useSession((s) => s.lightboxImages !== null);
  const group = useMemo(() => (current ? groupOf(current) : []), [current]);

  // Whether a drawer was showing on the LAST render: the next question swaps
  // in place instead of re-running the arrival slide (updated after paint, so
  // the same render that consults it still sees the previous state).
  const wasUp = useRef(false);
  useEffect(() => {
    wasUp.current = current !== undefined && raised;
  });

  // Escape: cancel an in-progress pick first, then lower the drawer (drafts
  // live in the store, so lowering costs nothing). Yields to the surfaces that
  // own Escape while they are up, so one press only ever does one thing.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || diffMode || lightbox) return;
      if (picking !== null) {
        e.preventDefault();
        cancelAnswerPick();
        return;
      }
      if (!raised) return;
      e.preventDefault();
      dismissQuestionDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, raised, picking, diffMode, lightbox, cancelAnswerPick, dismissQuestionDrawer]);

  if (!current) return null;
  return raised ? (
    <Drawer key={current.id} q={current} group={group} pending={pending} animate={!wasUp.current} />
  ) : (
    <ReopenBar pending={pending} />
  );
};
