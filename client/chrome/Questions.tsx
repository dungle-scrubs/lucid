import { focusQuestionRef, sendAnswer, setAnswerDraft } from "./actions.ts";
import { useLucid } from "./store.ts";
import { Kbd } from "./ui/kbd.tsx";

/**
 * Questions the agent is blocked on. Anchored above the composer rather than in
 * the record: they are outstanding work, not history, and burying them in a
 * long transcript is how an agent waits forever.
 */
export const Questions = () => {
  const questions = useLucid((s) => s.questions);
  const answerDrafts = useLucid((s) => s.answerDrafts);
  const open = questions.filter((q) => !q.answered);
  const answered = questions.filter((q) => q.answered);
  if (questions.length === 0) return null;

  return (
    <section className="border-t border-ink-600 bg-bg-inset p-[12px_14px]">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-muted">
        Questions for you{open.length > 0 ? ` (${open.length})` : ""}
      </h3>
      <div className="flex flex-col gap-2.5">
        {open.map((q) => (
          <div
            key={q.id}
            data-test="question"
            className="flex flex-col gap-1.5 rounded-lg border border-ink-600 bg-ink-850 px-[11px] py-[10px]"
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
            <textarea
              rows={2}
              className="qinput resize-y rounded-md border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline"
              placeholder="Your answer… (Enter to send, Shift+Enter for a new line)"
              value={answerDrafts[q.id] ?? ""}
              onChange={(e) => setAnswerDraft(q.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendAnswer(q);
                }
              }}
            />
            <button
              type="button"
              data-test="answer"
              disabled={(answerDrafts[q.id] ?? "").trim().length === 0}
              onClick={() => void sendAnswer(q)}
              className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-accent bg-accent px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-on-accent hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              Answer
              <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
            </button>
          </div>
        ))}
        {answered.map((q) => (
          <div
            key={q.id}
            data-test="question-answered"
            className="flex flex-col gap-1.5 rounded-lg border border-ink-600 bg-ink-850/60 px-[11px] py-[10px] opacity-80"
          >
            <div className="text-fg-muted">{q.text}</div>
            <div className="text-fg">
              <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-[0.6px] text-user">
                you
              </span>
              {q.answer}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
