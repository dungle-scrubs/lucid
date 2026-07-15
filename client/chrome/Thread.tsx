import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantDataUI,
  useMessage,
} from "@assistant-ui/react";
import { approveReview, reopenReview } from "./actions.ts";
import { AnnotationPart } from "./AnnotationPart.tsx";
import { Orphans, PendingComposer, Queue, Warnings } from "./Panel.tsx";
import { Questions } from "./Questions.tsx";
import { useLucid } from "./store.ts";

/**
 * The review record. assistant-ui owns the transcript, the composer and the
 * scroll behaviour; Lucid owns what the entries mean.
 */

const Thumb = ({ src, alt }: { readonly src: string; readonly alt: string }) => (
  <button
    type="button"
    data-test="thumb"
    title={alt}
    className="cursor-zoom-in rounded-md focus-visible:annot-outline"
    onClick={() => window.dispatchEvent(new CustomEvent("lucid:lightbox", { detail: src }))}
  >
    <img
      className="block h-[66px] w-[88px] rounded-md border border-ink-600 object-cover hover:border-accent"
      src={src}
      alt={alt}
    />
  </button>
);

const parts = {
  Text: ({ text }: { readonly text: string }) => (
    <span className="whitespace-pre-wrap leading-[1.45] text-fg">{text}</span>
  ),
  Image: ({ image }: { readonly image: string }) => <Thumb src={image} alt="attachment" />,
} as const;

/**
 * Both a typed message and an annotation arrive as `user` turns, so the label
 * is decided by what the message carries: an annotation is a card that speaks
 * for itself and must not wear a "human" header.
 */
const UserMessage = () => {
  // A `data-annotation` part is normalised on the way in to
  // `{ type: "data", name: "annotation" }` - the prefix moves into `name`.
  const isAnnotation = useMessage((m) =>
    m.content.some((p) => p.type === "data" && p.name === "annotation"),
  );
  if (isAnnotation) return <MessagePrimitive.Parts components={parts} />;
  return (
    <div className="flex flex-col gap-[3px]" data-role="human">
      {/* Amber is the human. */}
      <span className="text-[10px] font-semibold uppercase tracking-[0.6px] text-user">human</span>
      <div className="flex flex-wrap gap-1.5">
        <MessagePrimitive.Parts components={parts} />
      </div>
    </div>
  );
};

/** Sage is the agent. */
const AssistantMessage = () => (
  <div className="flex flex-col gap-[3px]" data-role="agent">
    <span className="text-[10px] font-semibold uppercase tracking-[0.6px] text-agent">agent</span>
    <div className="flex flex-wrap gap-1.5">
      <MessagePrimitive.Parts components={parts} />
    </div>
  </div>
);

/** A staged paste, before the message carrying it is sent. */
const ComposerAttachment = () => (
  <AttachmentPrimitive.Root
    data-test="image-chip"
    className="inline-flex items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800 py-[3px] pr-[6px] pl-[3px]"
  >
    <AttachmentPrimitive.unstable_Thumb className="size-[22px] rounded-full object-cover" />
    <span className="max-w-[150px] truncate text-[11px] text-cream-300">
      <AttachmentPrimitive.Name />
    </span>
    <AttachmentPrimitive.Remove
      title="Remove"
      className="cursor-pointer px-[3px] text-fg-muted hover:text-rust-300"
    >
      ×
    </AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>
);

const Composer = () => (
  <ComposerPrimitive.Root className="flex flex-col gap-2 border-t border-ink-600 bg-bg p-[14px]">
    <div className="flex flex-wrap gap-1.5 empty:hidden">
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
    </div>
    <ComposerPrimitive.Input
      rows={2}
      data-test="message-input"
      placeholder="Message the agent, or paste an image… (Enter to send, Shift+Enter for a new line)"
      className="resize-y rounded-md border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline"
    />
    <div className="flex items-center gap-2">
      <ComposerPrimitive.Send
        data-test="send-message"
        className="cursor-pointer rounded-md border border-ink-600 bg-ink-700 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Send message
      </ComposerPrimitive.Send>
    </div>
  </ComposerPrimitive.Root>
);

/** Approve ends the agent's involvement until it is re-invoked (D-064), so it
 *  is not a bigger Send - it is the opposite. Kept apart from the composer. */
const ReviewBar = () => {
  const resolved = useLucid((s) => s.reviewResolved);
  return (
    <div
      data-test={resolved ? "resolved-bar" : "review-bar"}
      className="flex items-center justify-between gap-2 border-t border-ink-600 bg-bg px-[14px] py-2"
    >
      {resolved ? (
        <>
          <span className="text-[12px] text-agent">✓ Review approved</span>
          <button
            type="button"
            data-test="reopen"
            onClick={() => void reopenReview()}
            className="cursor-pointer rounded-md border border-ink-600 bg-ink-700 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600"
          >
            Reopen review
          </button>
        </>
      ) : (
        <>
          <span className="text-[11px] text-fg-faint">Done reviewing?</span>
          <button
            type="button"
            data-test="approve"
            onClick={() => void approveReview()}
            className="cursor-pointer rounded-md border border-sage-600 bg-sage-600 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-cream-50 hover:bg-sage-500"
          >
            Approve review
          </button>
        </>
      )}
    </div>
  );
};

export const Thread = () => {
  // Registers the renderer for the `data-annotation` parts that convertMessage
  // emits. Without it those parts fall through to the unknown-data fallback.
  useAssistantDataUI({ name: "annotation", render: AnnotationPart });
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        // Anchored to the bottom: this is a record of what happened, so new
        // entries belong at the end and the eye should follow them.
        autoScroll
        scrollToBottomOnRunStart
        className="flex flex-1 flex-col gap-[18px] overflow-y-auto p-[14px_14px_12px]"
      >
        <ThreadPrimitive.Empty>
          <div className="text-[12px] italic text-fg-faint">No feedback sent yet.</div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        {/* Staged work lives at the end of the record, where the eye already is
            after a pick - and where auto-scroll brings it. */}
        <Orphans />
        <Warnings />
        <Queue />
        <PendingComposer />
      </ThreadPrimitive.Viewport>
      <Questions />
      <Composer />
      <ReviewBar />
    </ThreadPrimitive.Root>
  );
};
