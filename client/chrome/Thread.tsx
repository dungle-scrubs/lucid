import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantDataUI,
  useMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { AnnotationPart } from "./AnnotationPart.tsx";
import { useSession, useSessionHandle } from "./context.tsx";
import { DeliveryLabel } from "./Delivery.tsx";
import { visibleEl } from "./dom.ts";
import { FoldedText } from "./FoldedText.tsx";
import { useEffect, useState } from "react";
import {
  Notices,
  PendingComposer,
  QueuedCard,
  SelectionPickers,
  SendQueueBar,
  UnsentMessages,
  Warnings,
} from "./Panel.tsx";
import { QaPart } from "./QaPart.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { markdownComponents, prose, urlTransform } from "./ui/markdown.tsx";
import { closeButtonSmall } from "./ui/close.ts";

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

/** The human's own turns stay verbatim: what they typed is a quote, not a
 *  document, so it renders as plain text (no markdown surprises on a stray
 *  `*` or `#`). Whitespace is preserved, and a wall of it folds. */
const parts = {
  Text: ({ text }: { readonly text: string }) => <FoldedText text={text} />,
  Image: ({ image }: { readonly image: string }) => <Thumb src={image} alt="attachment" />,
} as const;

/** The agent speaks in Markdown: code spans, lists, tables and emphasis render
 *  as themselves, through the one shared treatment (ui/markdown.tsx) so a
 *  question and a transcript turn read identically. `smooth` is off - the
 *  record replays completed turns, so a typing reveal on already-delivered
 *  prose would be a lie about liveness. */
const AgentMarkdown = () => (
  <MarkdownTextPrimitive
    smooth={false}
    remarkPlugins={[remarkGfm]}
    urlTransform={urlTransform}
    className={prose}
    components={markdownComponents}
  />
);

const assistantParts = {
  Text: AgentMarkdown,
  Image: ({ image }: { readonly image: string }) => <Thumb src={image} alt="attachment" />,
} as const;

/**
 * Conversation bubbles per the design kit: no attribution headings - alignment
 * and fill carry who is speaking (amber tint right = the human, sage tint left
 * = the agent), with the tighter corner on the speaker's side. Brass stays out
 * of the log: color marks WHO here, never attention.
 *
 * Annotation and queued cards ride `user` turns too, but they are full-width
 * cards that speak for themselves - only a typed message gets a bubble.
 */
const UserMessage = () => {
  const isCard = useMessage((m) => m.content.some((p) => p.type === "data"));
  if (isCard) return <MessagePrimitive.Parts components={parts} />;
  return (
    // items-end, not justify-end: the delivery state sits under the bubble on
    // the speaker's side, and both stay right-aligned as the bubble wraps.
    <div className="flex flex-col items-end gap-1" data-role="human">
      <div className="flex min-w-0 max-w-[85%] flex-wrap gap-1.5 rounded-md rounded-tr-[4px] border border-cream-100/10 bg-user/16 px-3 py-2">
        <MessagePrimitive.Parts components={parts} />
      </div>
      <DeliveryLabel />
    </div>
  );
};

/** The agent speaks in the open: full-width, no container. Everything else in
 *  the record wears a shape (amber bubble, bordered card), so bare prose reads
 *  unmistakably as the agent without a bubble of its own. */
const AssistantMessage = () => (
  <div className="flex min-w-0 flex-col gap-1.5" data-role="agent">
    <MessagePrimitive.Parts components={assistantParts} />
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
      className={`${closeButtonSmall} hover:text-rust-300`}
    >
      ×
    </AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>
);

const Composer = () => {
  const { pastes } = useSessionHandle();
  return (
    <ComposerPrimitive.Root className="flex flex-col gap-2 border-t border-ink-600 bg-bg p-[14px]">
      <ListenerLine />
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
      </div>
      <ComposerPrimitive.Input
        rows={2}
        data-test="message-input"
        placeholder="Message the agent, or paste an image… (Enter to send, Shift+Enter for a new line)"
        // Large text pastes fold to `[Pasted text #N +L lines]` and expand back
        // at send; image pastes fall through to the attachment adapter.
        onPaste={pastes.collapseTextPaste}
        className="resize-y rounded-md border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline"
      />
      {/* Under the input, on the send line: who the NEXT unattended turn runs
          as belongs beside the act of sending it, not above the box. */}
      <div className="flex flex-wrap items-center gap-2">
        <SelectionPickers />
        <span className="flex-1" />
        <ComposerPrimitive.Send
          data-test="send-message"
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-ink-600 bg-ink-700 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send message
          <Kbd>↵</Kbd>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
};

/** Ten minutes with no output stops being "working" and becomes a fact the
 *  human should see plainly: the feedback was picked up, nothing came back. */
const WORKING_STALE_MS = 10 * 60 * 1000;

/**
 * The agent took delivery and has not produced anything yet. Sage, because it
 * is the agent speaking - or rather, the agent's silence. Driven entirely by
 * the log (ack opens it, version/reply/question closes it), so it can never
 * claim work that is not happening... though it can miss work by a crashed
 * agent, which is exactly what the stale state is for.
 */
const WorkingIndicator = () => {
  const working = useSession((s) => s.agentWorking);
  const status = useSession((s) => s.status);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  if (!working || status !== "active") return null;
  const elapsed = Math.max(0, now - new Date(working.since).getTime());
  const stale = elapsed >= WORKING_STALE_MS;
  const mm = Math.floor(elapsed / 60000);
  const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0");

  // Fan-out: the agent self-reported parallel subagents working the revision.
  // A distinct rendering (agent-colored dots + counts) so the human reads "many
  // agents in flight, this will take a bit" rather than a lone spinner.
  const progress = working.progress;
  if (progress && !stale) {
    const { label, total, done } = progress;
    return (
      <div
        data-test="agent-working"
        data-fanout="true"
        data-stale="false"
        className="flex flex-col gap-0.5 text-[12px]"
      >
        <div className="flex items-baseline gap-1.5">
          <span aria-hidden className="animate-pulse text-agent tracking-[0.2em]">
            ●●●
          </span>
          <span className="shimmer text-fg/40">
            {total ? `${total} agents in progress…` : "agents in progress…"}
          </span>
          {total ? (
            <span className="text-[11px] text-fg-faint tabular-nums">
              {/* total and done can arrive on separate acks, so clamp here -
                  the one place that sees both - rather than trust done<=total. */}
              {Math.min(done ?? 0, total)}/{total} reported
            </span>
          ) : null}
          <span className="text-[11px] text-fg-faint tabular-nums">
            ({mm}:{ss})
          </span>
        </div>
        {label ? <span className="text-[11px] text-fg-muted">{label}</span> : null}
      </div>
    );
  }

  return (
    <div
      data-test="agent-working"
      data-stale={stale ? "true" : "false"}
      className="flex items-baseline gap-1.5 text-[12px]"
    >
      {stale ? (
        <span className="text-fg-muted">
          {progress ? "agents picked up" : "agent picked up"} your feedback {mm}m ago · no response
          yet
        </span>
      ) : (
        <>
          {/* tw-shimmer clips to the text, so the base color's opacity is what
              makes the sweep visible (their documented /40 idiom). */}
          <span className="shimmer text-fg/40">
            {working.intent === "revise" ? "Updating the artifact…" : "Agent responding…"}
          </span>
          <span className="text-[11px] text-fg-faint tabular-nums">
            ({mm}:{ss})
          </span>
        </>
      )}
    </div>
  );
};

/**
 * Presence above the prompt: is anyone on the other end right now. Listening
 * (an agent blocked in wait, its waker connected) is distinct from working
 * (delivery acked, output pending) - while working the agent is deliberately
 * disconnected, so this line yields to the working indicator rather than
 * contradicting it.
 */
const ListenerLine = () => {
  const listening = useSession((s) => s.agentsListening);
  const working = useSession((s) => s.agentWorking);
  const status = useSession((s) => s.status);
  if (status !== "active" || working) return null;
  return (
    <div className="flex flex-col gap-1">
      <div
        data-test="listener-line"
        data-listening={listening > 0 ? "true" : "false"}
        className="flex items-center justify-center text-center text-[11px]"
      >
        {listening > 0 ? (
          <span className="text-agent">
            {listening === 1 ? "agent listening" : `${listening} agents listening`}
          </span>
        ) : (
          <span className="text-fg-faint">
            no agent connected · feedback is recorded and delivered when one checks in
          </span>
        )}
      </div>
      {listening === 0 ? <ResumeHint /> : null}
    </div>
  );
};

/**
 * The way back when nobody is listening: the last attendant's recorded resume
 * command, copied for the human to paste into a terminal themselves. The
 * screen grants no power - Lucid displays the command, it never runs it.
 */
const ResumeHint = () => {
  const { notify } = useSessionHandle();
  const attendant = useSession((s) => s.lastAttendant);
  const [copied, setCopied] = useState(false);
  if (!attendant?.resume) return null;
  const cmd = attendant.resume;
  return (
    <button
      type="button"
      data-test="resume-copy"
      title={cmd}
      onClick={() => {
        navigator.clipboard.writeText(cmd).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => notify.warn("Couldn't copy - the command is in this button's tooltip."),
        );
      }}
      className="flex cursor-pointer items-center gap-1.5 self-start text-[11px] text-fg-faint hover:text-fg"
    >
      {copied ? (
        // lucide check
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
          className="text-agent"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        // lucide copy
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
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
      <span data-test="resume-copy-label">
        {copied
          ? "copied - paste it in a terminal"
          : `copy the command to resume the ${attendant.harness} conversation`}
      </span>
    </button>
  );
};

const QueuedPart = ({ data }: { readonly data: { id: string; index: number } }) => (
  <QueuedCard id={data.id} index={data.index} />
);

/**
 * Our own at-bottom tracking rather than ThreadPrimitive.ScrollToBottom: that
 * primitive's viewport store never left isAtBottom=true under our external-
 * store composition, so its button stayed disabled forever. A scroll listener
 * plus a re-check whenever the record grows is the whole requirement. Sticky
 * inside the viewport so it floats over the scrolling content; floats, so it
 * earns a shadow.
 */
const ScrollToLatest = () => {
  const [atBottom, setAtBottom] = useState(true);
  // Where "bottom" is changes when the record grows; these are the slices
  // that grow it.
  const tick = useSession((s) => s.messages.length + s.annotations.length + s.queue.length);

  useEffect(() => {
    // Reading `tick` is the point: the effect re-checks whenever the record
    // grows, since growth moves where "bottom" is without any scroll event.
    if (tick < 0) return;
    const el = visibleEl('[data-test="thread-viewport"]');
    if (!el) return;
    const check = (): void =>
      setAtBottom(
        el.scrollHeight - el.scrollTop - el.clientHeight <= 2 || el.scrollHeight <= el.clientHeight,
      );
    check();
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, [tick]);

  return (
    <div className="pointer-events-none sticky bottom-0 z-10 flex justify-center">
      <button
        type="button"
        data-test="scroll-bottom"
        title="Scroll to the latest"
        disabled={atBottom}
        onClick={() => {
          const el = visibleEl('[data-test="thread-viewport"]');
          el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }}
        className="pointer-events-auto flex size-8 cursor-pointer items-center justify-center rounded-full border border-ink-400 bg-ink-800/95 text-fg shadow-[0_4px_14px_rgba(0,0,0,0.45)] hover:bg-ink-700 disabled:invisible"
      >
        {/* lucide chevron-down */}
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
};

export const Thread = () => {
  // Registers the renderer for the `data-annotation` parts that convertMessage
  // emits. Without it those parts fall through to the unknown-data fallback.
  useAssistantDataUI({ name: "annotation", render: AnnotationPart });
  useAssistantDataUI({ name: "queued", render: QueuedPart });
  // An answered question and its answer, as one entry (D14). Outstanding
  // questions never reach the transcript - they live in the drawer over the
  // surface, which is why there is no questions panel above the composer.
  useAssistantDataUI({ name: "qa", render: QaPart });
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        // Anchored to the bottom: this is a record of what happened, so new
        // entries belong at the end and the eye should follow them - but only
        // when the eye is already there. autoScroll never yanks a reader who
        // scrolled up; submitting (a run start, or queueing an annotation)
        // is an explicit "take me back down".
        autoScroll
        scrollToBottomOnRunStart
        data-test="thread-viewport"
        // overflow-x-hidden: this is a vertical record; wide content scrolls
        // inside its own container (pre, table) and everything else wraps, so
        // any residual horizontal overflow is a rendering artifact to clip,
        // never something to hand the reader a scrollbar for.
        className="flex flex-1 flex-col gap-[18px] overflow-x-hidden overflow-y-auto p-[14px_14px_12px]"
      >
        <ThreadPrimitive.Empty>
          <div className="text-[12px] italic text-fg-faint">
            No feedback sent yet. Click an element or select text in the artifact to annotate it.
          </div>
        </ThreadPrimitive.Empty>
        {/* Bottom-anchor sparse content the way every chat does: this spacer
            eats the free space above it, so a short record rests just over the
            composer instead of stranding one message at the top. When the
            record outgrows the viewport the spacer collapses to zero and it
            scrolls from the top, oldest-first, unchanged. */}
        <div aria-hidden className="mt-auto" />
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <WorkingIndicator />
        {/* Staged work lives at the end of the record, where the eye already is
            after a pick - and where auto-scroll brings it. */}
        <Warnings />
        <Notices />
        {/* Undelivered messages sit directly above the composer that lost them,
            where the eye lands after pressing Enter. */}
        <UnsentMessages />
        <PendingComposer />
        <ScrollToLatest />
      </ThreadPrimitive.Viewport>
      <SendQueueBar />
      <Composer />
    </ThreadPrimitive.Root>
  );
};
