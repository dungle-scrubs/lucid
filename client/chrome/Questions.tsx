import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  addAnswerImage,
  cancelAnswerPick,
  clearAnswerAnchor,
  focusQuestionRef,
  reaskQuestion,
  removeAnswerImage,
  sendAnswer,
  setAnswerDraft,
  skipQuestion,
  startAnswerPick,
  toggleAnswerOption,
} from "./actions.ts";
import { useLucid } from "./store.ts";
import type { AgentQuestion } from "./types.ts";
import { Kbd } from "./ui/kbd.tsx";
import { Markdown } from "./ui/markdown.tsx";

/** Short, human excerpt of a pinned region for the chip - the anchor's snippet
 *  is outerHTML, so strip tags and clip. */
const anchorLabel = (snippet: string): string => {
  const text = snippet
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text || "pinned region";
};

/** Past this height a question is a wall, not a prompt: the panel sits above
 *  the composer, so an unbounded one pushes the record off screen. */
const CLAMP_PX = 200;

/**
 * The question itself, in the agent's Markdown - paragraphs, lists, and fenced
 * code render as themselves, the same treatment the transcript gives agent
 * prose. A long one clamps to a readable height with the rest one click away:
 * the ask stays in view next to the buttons that act on it.
 */
const QuestionText = ({ text }: { readonly text: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);

  // Layout effect, and re-measured on resize: the panel is draggable, so the
  // same question is two lines at one width and ten at another - and measuring
  // after paint would flash the wall it exists to prevent.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight is the full content height even while clamped, so this stays
    // correct once folded. Tolerance: a few pixels over is not worth a
    // disclosure, and late-loading fonts nudge the measurement.
    const measure = (): void => setLong(el.scrollHeight > CLAMP_PX + 24);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <div
          ref={ref}
          data-test="question-text"
          className={long && !open ? "overflow-hidden" : undefined}
          style={long && !open ? { maxHeight: CLAMP_PX } : undefined}
        >
          <Markdown text={text} />
        </div>
        {long && !open ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-ink-850 to-transparent" />
        ) : null}
      </div>
      {long ? (
        <button
          type="button"
          data-test="question-fold"
          onClick={() => setOpen((v) => !v)}
          className="w-fit cursor-pointer text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
        >
          {open ? "Show less" : "Show the rest"}
        </button>
      ) : null}
    </div>
  );
};

/** One open question with its full answer surface: options, note, a pinned
 *  artifact region, and attached images. */
const OpenQuestion = ({ q }: { q: AgentQuestion }) => {
  const draft = useLucid((s) => s.answerDrafts[q.id] ?? "");
  const chosen = useLucid((s) => s.answerOptions[q.id]);
  const anchor = useLucid((s) => s.answerAnchors[q.id]);
  const images = useLucid((s) => s.answerImages[q.id]);
  const picking = useLucid((s) => s.answerPickFor === q.id);
  const uploading = useLucid((s) => s.answerUploading[q.id] ?? 0) > 0;
  const options = chosen ?? [];
  const imgs = images ?? [];
  const hasContent =
    draft.trim().length > 0 || options.length > 0 || Boolean(anchor) || imgs.length > 0;
  const ready = hasContent && !uploading;

  return (
    <div
      data-test="question"
      className="flex flex-col gap-2 rounded-lg border border-ink-600 bg-ink-850 px-[11px] py-[10px]"
    >
      <QuestionText text={q.text} />
      {q.ref ? (
        <button
          type="button"
          onClick={() => focusQuestionRef(q.ref)}
          className="w-fit cursor-pointer text-[11px] text-accent-bright underline-offset-2 hover:underline"
        >
          Show me where
        </button>
      ) : null}

      {q.options && q.options.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {q.options.map((opt, i) => {
            const on = options.includes(opt.label);
            // Number in authored order so a prose note can reference a choice by
            // its numeral ("I'd go with 1 and 3") and the agent can map it back.
            return (
              <button
                key={opt.label}
                type="button"
                data-test="option"
                aria-pressed={on}
                onClick={() => toggleAnswerOption(q, opt.label)}
                onKeyDown={(e) => {
                  // Enter on a focused option submits the whole answer instead
                  // of re-toggling it (Space still toggles). Without this,
                  // pressing Enter after clicking options just flipped the last
                  // one off - an options-only answer couldn't be sent by Enter.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendAnswer(q);
                  }
                }}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-left ${
                  on
                    ? "border-accent bg-accent/15 text-fg"
                    : "border-ink-600 bg-bg-inset text-fg hover:border-ink-400"
                }`}
              >
                <span
                  className={`mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[11px] font-semibold tabular-nums ${
                    q.multi ? "rounded" : "rounded-full"
                  } ${on ? "bg-accent text-on-accent" : "bg-ink-700 text-fg-muted"}`}
                >
                  {i + 1}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium">{opt.label}</span>
                  {opt.description ? (
                    <span className="text-[11px] text-fg-muted">{opt.description}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
          <span className="text-[10px] text-fg-faint">
            {q.multi
              ? "Choose any that apply, or reference by number in a note"
              : "Reference a choice by number in a note"}
          </span>
        </div>
      ) : null}

      <textarea
        rows={2}
        className="qinput resize-y rounded-md border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline"
        placeholder={
          q.options && q.options.length > 0
            ? "Add a note (optional)… (Enter to send)"
            : "Your answer… (Enter to send, Shift+Enter for a new line)"
        }
        value={draft}
        onChange={(e) => setAnswerDraft(q.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void sendAnswer(q);
          }
        }}
      />

      {/* Reference the artifact and attach images - the same materials as an
          annotation, gathered onto the answer instead. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {anchor ? (
          <span
            data-test="answer-anchor"
            className="inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2 py-px text-[11px] text-fg"
          >
            <span className="text-accent-bright">◎</span>
            {anchorLabel(anchor.snippet)}
            <button
              type="button"
              aria-label="Remove pinned region"
              onClick={() => clearAnswerAnchor(q)}
              className="cursor-pointer text-fg-faint hover:text-fg"
            >
              ×
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-test="pin-region"
            onClick={() => (picking ? cancelAnswerPick() : startAnswerPick(q))}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-px text-[11px] ${
              picking
                ? "border-accent-bright bg-ink-700 text-accent-bright"
                : "border-ink-400 text-fg-muted hover:border-accent-bright hover:text-fg"
            }`}
          >
            {picking ? "Click a spot in the artifact · Esc to cancel" : "◎ Pin a spot"}
          </button>
        )}

        <label className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-ink-400 px-2 py-px text-[11px] text-fg-muted hover:border-accent-bright hover:text-fg">
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
      </div>

      {imgs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {imgs.map((img) => (
            <span key={img.id} className="relative inline-block">
              <img
                src={img.url}
                alt={img.name}
                className="h-12 w-12 rounded border border-ink-600 object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                onClick={() => removeAnswerImage(q, img.id)}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-ink-400 bg-ink-850 text-[10px] text-fg-muted hover:text-fg"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-test="answer"
          disabled={!ready}
          onClick={() => void sendAnswer(q)}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-accent bg-accent px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-on-accent hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {uploading ? "Uploading…" : "Answer"}
          <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
        </button>
        {/* Decline: clears the question and tells the agent to proceed without
            an answer - the escape hatch for a question you can't or won't answer. */}
        <button
          type="button"
          data-test="skip"
          onClick={() => void skipQuestion(q)}
          className="w-fit cursor-pointer text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
        >
          Skip
        </button>
        {/* The other escape hatch, and the more common one: the question is not
            unanswerable, it is unreadable. Hands it back for a clearer, shorter
            version instead of forcing a guess or a decline. A note, if there is
            one, rides along as what was confusing. */}
        <button
          type="button"
          data-test="reask"
          title="I don't understand - have the agent ask again, more clearly"
          onClick={() => void reaskQuestion(q)}
          className="w-fit cursor-pointer text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
        >
          Re-ask
        </button>
      </div>
    </div>
  );
};

/**
 * Questions the agent is blocked on. Slides up from the bottom of the panel
 * (above the composer): they are outstanding work, not history, and burying
 * them in a long transcript is how an agent waits forever. An answer can carry
 * chosen options, a note, a pinned artifact region, and images - the same
 * materials as an annotation, gathered as a reply.
 */
export const Questions = () => {
  const questions = useLucid((s) => s.questions);
  const pickFor = useLucid((s) => s.answerPickFor);
  // The panel is an inbox of OUTSTANDING questions, not a history: once answered,
  // a question leaves it (the answer is in the log, and the agent acts on it).
  // Keeping answered cards pinned here forever was just clutter above the composer.
  const open = questions.filter((q) => !q.answered);
  const hasOpen = open.length > 0;

  // Slide-up when the panel goes from empty to populated. The component stays
  // mounted returning null while empty, so keying the transition on presence
  // (not mount) is what makes a mid-review question actually slide up.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!hasOpen) {
      setShown(false);
      return;
    }
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [hasOpen]);

  // Esc cancels an in-progress artifact pick.
  useEffect(() => {
    if (pickFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelAnswerPick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickFor]);

  if (!hasOpen) return null;

  return (
    <section
      data-test="questions-panel"
      // Bounded: the inbox may hold several questions with options apiece, and
      // it must never grow past the window and push the composer - the thing
      // that answers them - off screen. Past half the viewport it scrolls.
      className={`max-h-[55vh] overflow-y-auto border-t border-ink-600 bg-bg-inset p-[12px_14px] transition-transform duration-200 ease-out ${
        shown ? "translate-y-0" : "translate-y-full"
      }`}
    >
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-muted">
        Questions for you{open.length > 1 ? ` (${open.length})` : ""}
      </h3>
      <div className="flex flex-col gap-2.5">
        {open.map((q) => (
          <OpenQuestion key={q.id} q={q} />
        ))}
      </div>
    </section>
  );
};
