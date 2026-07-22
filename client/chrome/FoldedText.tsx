import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";

/**
 * Human-authored text, folded when it is a wall.
 *
 * The human's turns render verbatim - a quote, not a document - but a large
 * paste sent to the agent comes back from the log as hundreds of lines, and
 * verbatim must not mean the transcript stops being readable. Past the gate
 * the head stays visible and the rest folds behind a disclosure, the
 * transcript's answer to the composer's `[Pasted text #N +L lines]`.
 *
 * Rendering-side on purpose: the log carries plain text with no markers, so
 * this works identically for a live send, a reload replayed from the log,
 * and a long message that was typed rather than pasted.
 */

/** Past either bound the text folds; the head is what stays in view. */
const FOLD_LINES = 12;
const FOLD_CHARS = 1200;
const HEAD_LINES = 6;
const HEAD_CHARS = 600;

/** Verbatim quote styling, shared by both halves: whitespace preserved, long
 *  tokens broken rather than blowing out the panel. */
const quote = "whitespace-pre-wrap break-words leading-[1.45] text-fg";

/** Lucide `chevron-down`; rotates to point up while the fold is open. */
const ChevronGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="transition-transform group-data-[panel-open]:rotate-180"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const FoldedText = ({ text }: { readonly text: string }) => {
  const lines = text.split("\n");
  if (lines.length <= FOLD_LINES && text.length <= FOLD_CHARS) {
    return <span className={`min-w-0 max-w-full ${quote}`}>{text}</span>;
  }

  // Head by lines, capped by characters so one enormous line still folds.
  const byLines = lines.slice(0, HEAD_LINES).join("\n");
  const head = byLines.length > HEAD_CHARS ? byLines.slice(0, HEAD_CHARS) : byLines;
  // The newline between head and tail is the block boundary itself.
  const tail = text.slice(head.length).replace(/^\n/, "");
  const tailLines = tail.replace(/\n$/, "").split("\n").length;

  return (
    <Collapsible data-test="folded-text" className="min-w-0 max-w-full">
      <span className={quote}>{head}</span>
      <CollapsibleContent>
        <span className={quote}>{tail}</span>
      </CollapsibleContent>
      <CollapsibleTrigger
        data-test="fold-toggle"
        className="group mt-1 flex cursor-pointer items-center gap-1 text-[11px] text-fg-muted hover:text-fg"
      >
        <ChevronGlyph />
        <span className="group-data-[panel-open]:hidden">
          {tailLines > 1 ? `show ${tailLines} more lines` : "show the rest"}
        </span>
        <span className="hidden group-data-[panel-open]:inline">show less</span>
      </CollapsibleTrigger>
    </Collapsible>
  );
};
