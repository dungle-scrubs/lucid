import type { DataMessagePartComponent } from "@assistant-ui/react";
import { summarizeItemAnswer } from "../../src/core/question-contract.ts";
import { TargetSnippet } from "./AnnotationPart.tsx";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { FoldedText } from "./FoldedText.tsx";
import { groupOf } from "./question-draft.ts";
import type { MessageImage } from "./types.ts";
import { Markdown } from "./ui/markdown.tsx";

export interface QaData {
  /** The asked question's id; the card reads it live from the store, so a
   *  re-answer (or a late-arriving image path) re-renders without reconverting
   *  the timeline. */
  readonly id: string;
}

/**
 * An answered question and its answer, as ONE entry in the record (D14).
 *
 * The question is dim and the answer is prominent: by the time this exists the
 * question is settled, and what the record is FOR is the decision. Nothing
 * renders here until the human answers - an outstanding question lives in the
 * drawer, not in the transcript, so a card can never drift above the reply it
 * produced.
 */
export const QaPart: DataMessagePartComponent<QaData> = ({ data }) => {
  const { openLightbox } = useActions();
  const { transport } = useSessionHandle();
  const question = useSession((s) => s.questions.find((q) => q.id === data.id));
  if (!question?.answered) return null;
  const group = groupOf(question);
  const items = question.answerItems ?? [];
  const images: readonly MessageImage[] = question.answerImages ?? [];
  // A LEGACY answer has no per-item structure: its content is the chosen option
  // labels plus any free text, and an options-only answer has no `answer` line
  // at all - reading only that field printed "(no answer)" over a real choice.
  const legacy = [...(question.answerOptions ?? []), ...(question.answer ? [question.answer] : [])]
    .join(", ")
    .trim();

  return (
    <section
      data-test="qa"
      data-question-id={question.id}
      aria-label="Question and answer"
      className="flex flex-col gap-2 rounded-lg border border-ink-600 bg-ink-700 px-[11px] py-[10px]"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
        {question.skipped
          ? "Question · declined"
          : question.unclear
            ? "Question · re-ask requested"
            : "Question · answered"}
      </span>
      {question.skipped || question.unclear ? (
        <>
          {/* The same Markdown the drawer rendered: a fenced command must not
              decay to literal backticks the moment the question settles. */}
          <div className="text-[12px] leading-[1.45] text-fg-muted [&_.text-fg]:text-fg-muted">
            <Markdown text={question.text} />
          </div>
          <div className="text-[12px] text-fg-faint italic" data-test="qa-answer">
            {question.unclear
              ? question.answer
                ? `Unclear - "${question.answer}" - the agent owes a plainer version.`
                : "Unclear - the agent owes a plainer version of this question."
              : "Skipped - the agent was told to proceed without an answer."}
          </div>
        </>
      ) : (
        <ol className="flex flex-col gap-2">
          {group.map((item) => {
            const answer = items.find((a) => a.id === item.id);
            const line = answer ? summarizeItemAnswer(item, answer) : legacy;
            return (
              <li key={item.id} className="flex flex-col gap-1">
                <div className="text-[12px] leading-[1.45] text-fg-muted [&_.text-fg]:text-fg-muted">
                  <Markdown text={item.question} />
                </div>
                {/* The decision, on a frost rule: the one thing a reader scans
                    this card for. */}
                <div
                  data-test="qa-answer"
                  className="border-l-2 border-accent pl-2 text-[13px] text-fg-strong"
                >
                  {line.length > 0 ? <FoldedText text={line} /> : <span>(no answer)</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {/* Every pinned spot; `answerAnchor` is always the first of `answerAnchors`. */}
      {(question.answerAnchors ?? (question.answerAnchor ? [question.answerAnchor] : [])).map(
        (t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: anchors have no id and a settled answer's list never changes.
          <TargetSnippet key={i} target={t} />
        ),
      )}
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <button
              key={img.file}
              type="button"
              data-test="qa-thumb"
              title={img.name}
              onClick={() => openLightbox(images, i)}
              className="cursor-zoom-in rounded-md focus-visible:annot-outline"
            >
              <img
                src={transport.assetUrl(img.file)}
                alt={img.name}
                className="block h-[66px] w-[88px] rounded-md border border-ink-600 object-cover hover:border-accent"
              />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
};
