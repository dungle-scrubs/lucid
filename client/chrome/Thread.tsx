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
import { defaultUrlTransform } from "react-markdown";
import type { ReactNode } from "react";
import { AnnotationPart } from "./AnnotationPart.tsx";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { DeliveryLabel } from "./Delivery.tsx";
import { visibleEl } from "./dom.ts";
import { FoldedText } from "./FoldedText.tsx";
import { useEffect, useState } from "react";
import {
  Notices,
  PendingComposer,
  QueuedCard,
  SendQueueBar,
  UnsentMessages,
  Warnings,
} from "./Panel.tsx";
import { Questions } from "./Questions.tsx";
import { Kbd } from "./ui/kbd.tsx";

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

/** A `lucid:section/<id>` link is an in-artifact permalink: the agent stamps a
 *  `data-lucid-id` on a new section and links to it, so the reader jumps there
 *  once without hunting. Ephemeral by design - it's a live chip only while the
 *  overlay still reports that id, and degrades to plain text the moment a later
 *  version drops it (no dead links left in the log). */
const SECTION_SCHEME = "lucid:section/";

/** react-markdown's default sanitizer strips unknown protocols, which would
 *  blank our `lucid:` hrefs; allow that one scheme through and sanitize the
 *  rest exactly as before (no javascript:, no data:). */
const urlTransform = (url: string): string =>
  url.startsWith(SECTION_SCHEME) ? url : defaultUrlTransform(url);

/** Lucide `locate-fixed` - "find this in the artifact". */
const LocateGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="11"
    height="11"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="2" x2="5" y1="12" y2="12" />
    <line x1="19" x2="22" y1="12" y2="12" />
    <line x1="12" x2="12" y1="2" y2="5" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** Section permalinks scroll the artifact; every other agent-authored link
 *  opens away from the viewer and never navigates it. */
const MarkdownLink = ({
  href,
  children,
}: {
  readonly href?: string;
  readonly children?: ReactNode;
}) => {
  const { revealSection } = useActions();
  const sectionIds = useSession((s) => s.sectionIds);
  const sectionId = href?.startsWith(SECTION_SCHEME) ? href.slice(SECTION_SCHEME.length) : null;

  if (sectionId !== null) {
    // Live while the id set is unknown (optimistic, pre-first-report) or holds
    // it; a dead permalink becomes plain text, not a chip that goes nowhere.
    const live = sectionIds === null || sectionIds.includes(sectionId);
    if (!live) return <span>{children}</span>;
    return (
      <button
        type="button"
        data-test="section-link"
        onClick={() => revealSection(sectionId)}
        title="Scroll the artifact to this section"
        className="mx-px inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 align-baseline text-[0.9em] font-medium text-accent hover:bg-accent/20"
      >
        <LocateGlyph />
        {children}
      </button>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  );
};

/** Markdown images never load. Agent-authored `![](url)` would auto-fetch an
 *  arbitrary URL - a tracking pixel, or a GET at a loopback dev service the
 *  viewer sits beside. Real attachments arrive as Image parts (Thumb), not
 *  markdown, so nothing is lost by showing the reference as inert text. */
const MarkdownImage = ({ alt }: { readonly alt?: string }) => (
  <span className="text-fg-faint italic">{alt ? `[image: ${alt}]` : "[image]"}</span>
);

/**
 * A "prose-lite" for the transcript: descendant utilities so one class carries
 * the whole document, sized down to the panel and pinned to the kit's tokens.
 * Block spacing lives on the container (`*+*`) so first children never inherit
 * a stray top margin. Fenced code gets an inset card; inline code a chip, with
 * the chip styling neutralised inside a fence so a block does not double up.
 */
const md = [
  "min-w-0 max-w-full text-fg leading-[1.45] [&>*+*]:mt-2 break-words",
  "[&_strong]:font-semibold [&_strong]:text-fg-strong [&_em]:italic",
  "[&_code]:rounded [&_code]:bg-ink-700 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.92em]",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-ink-600 [&_pre]:bg-bg-inset [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-[1.5]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em]",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-0.5 [&_li]:marker:text-fg-faint",
  "[&_:is(h1,h2,h3,h4)]:mt-3 [&_:is(h1,h2,h3,h4)]:text-[13px] [&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:text-fg-strong",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-ink-500 [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted [&_blockquote]:italic",
  "[&_hr]:my-3 [&_hr]:border-ink-600",
  "[&_table]:block [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[12px] [&_:is(th,td)]:border [&_:is(th,td)]:border-ink-600 [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_th]:text-left [&_th]:font-semibold",
].join(" ");

/** The agent speaks in Markdown: code spans, lists, tables and emphasis render
 *  as themselves. `smooth` is off - the record replays completed turns, so a
 *  typing reveal on already-delivered prose would be a lie about liveness. */
const AgentMarkdown = () => (
  <MarkdownTextPrimitive
    smooth={false}
    remarkPlugins={[remarkGfm]}
    urlTransform={urlTransform}
    className={md}
    components={{ a: MarkdownLink, img: MarkdownImage }}
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
      className="cursor-pointer px-[3px] text-fg-muted hover:text-rust-300"
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
      <div className="flex items-center justify-end gap-2">
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
      <Questions />
      <Composer />
    </ThreadPrimitive.Root>
  );
};
