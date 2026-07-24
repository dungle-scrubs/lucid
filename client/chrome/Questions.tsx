import { useEffect, useState } from "react";
import {
  addAnswerImage,
  cancelAnswerPick,
  clearAnswerAnchor,
  focusQuestionRef,
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

/** Short, human excerpt of a pinned region for the chip - the anchor's snippet
 *  is outerHTML, so strip tags and clip. */
const anchorLabel = (snippet: string): string => {
  const text = snippet
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text || "pinned region";
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
      <div className="text-fg">{q.text}</div>
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
          {q.options.map((opt) => {
            const on = options.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                data-test="option"
                aria-pressed={on}
                onClick={() => toggleAnswerOption(q, opt.label)}
                className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left ${
                  on
                    ? "border-accent bg-accent/15 text-fg"
                    : "border-ink-600 bg-bg-inset text-fg hover:border-ink-400"
                }`}
              >
                <span className="text-[13px] font-medium">{opt.label}</span>
                {opt.description ? (
                  <span className="text-[11px] text-fg-muted">{opt.description}</span>
                ) : null}
              </button>
            );
          })}
          {q.multi ? (
            <span className="text-[10px] text-fg-faint">Choose any that apply</span>
          ) : null}
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
      className={`border-t border-ink-600 bg-bg-inset p-[12px_14px] transition-transform duration-200 ease-out ${
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
