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
import { useHub } from "./hub.ts";
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
import { deliveredWaiting } from "./store.ts";
import { markdownComponents, prose, urlTransform } from "./ui/markdown.tsx";
import { closeButtonSmall } from "./ui/close.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * The review record. assistant-ui owns the transcript, the composer and the
 * scroll behaviour; Lucid owns what the entries mean.
 */

const Thumb = ({ src, alt }: { readonly src: string; readonly alt: string }) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          type="button"
          data-test="thumb"
          className="cursor-zoom-in focus-visible:annot-outline"
          onClick={() => window.dispatchEvent(new CustomEvent("lucid:lightbox", { detail: src }))}
        >
          <img
            className="block h-[66px] w-[88px] border border-ink-600 object-cover hover:border-accent"
            src={src}
            alt={alt}
          />
        </button>
      }
    />
    <TooltipContent>{alt}</TooltipContent>
  </Tooltip>
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
      <div className="flex min-w-0 max-w-[85%] flex-wrap gap-1.5 border border-cream-100/10 bg-user/16 px-3 py-2">
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
    className="inline-flex items-center gap-1.5 border border-ink-600 bg-ink-800 py-[3px] pr-[6px] pl-[3px]"
  >
    <AttachmentPrimitive.unstable_Thumb className="size-[22px] object-cover" />
    <span className="max-w-[150px] truncate text-[11px] text-cream-300">
      <AttachmentPrimitive.Name />
    </span>
    <Tooltip>
      <TooltipTrigger
        render={
          <AttachmentPrimitive.Remove
            aria-label="Remove"
            className={`${closeButtonSmall} hover:text-rust-300`}
          >
            ×
          </AttachmentPrimitive.Remove>
        }
      />
      <TooltipContent>Remove</TooltipContent>
    </Tooltip>
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
        className="resize-y border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline"
      />
      {/* Under the input, on the send line: who the NEXT unattended turn runs
          as belongs beside the act of sending it, not above the box.
          wrap-REVERSE: when the pickers and the button stop fitting side by
          side, the button takes the line ABOVE them rather than being pushed
          below the panel's own footer. */}
      <div className="flex flex-wrap-reverse items-center gap-2">
        <SelectionPickers />
        {/* No ↵ badge: the placeholder in the box above already says Enter
            sends, and the button repeating it was the same fact twice. */}
        <ComposerPrimitive.Send
          data-test="send-message"
          className="ml-auto flex cursor-pointer items-center border border-ink-600 bg-ink-700 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send message
        </ComposerPrimitive.Send>
      </div>
      <ConnectionLine />
      <AttendanceFooter />
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
  const awaitingAck = useSession((s) => s.awaitingAck);
  const listening = useSession((s) => s.agentsListening);
  const presence = useSession((s) => s.attendantPresence);
  const attendant = useSession((s) => s.lastAttendant);
  const resumable = useSession((s) => s.resumable);
  const attend = useHub((s) => s.attend) === true;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  // The delivered-to-ack gap: feedback is in the log, no working window is open
  // yet, and the log has nothing new to render. Fill the SAME slot the working
  // line will take, so "Delivered — waiting…" flows into "Updating the
  // artifact…" as one story rather than a gap and then a jump.
  if (!working && awaitingAck && status === "active") {
    const { text, transient } = deliveredWaiting({
      interactive: presence?.interactive === true,
      listening,
      spawnable: attend && resumable,
      harness: attendant?.harness ?? "the agent",
    });
    return (
      <div data-test="awaiting-ack" data-transient={transient} className="text-[12px]">
        <span className={transient ? "shimmer text-fg/40" : "text-fg-muted"}>{text}</span>
      </div>
    );
  }

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
  // Does the hub drive delivery itself? Null in the standalone viewer, where
  // there is no hub and nothing spawns - the same as false, for this line.
  const attend = useHub((s) => s.attend) === true;
  const resumable = useSession((s) => s.resumable);
  const status = useSession((s) => s.status);
  const presence = useSession((s) => s.attendantPresence);
  const attendant = useSession((s) => s.lastAttendant);
  if (status !== "active") return null;

  // A turn is RUNNING: this line stays on the MODE and says nothing about it.
  // Three places reported one running turn - the pill on the artifact, the
  // working card in the transcript (which carries the elapsed time and the
  // stale state), and a shimmer here. This one's only unique value was being
  // visible when the transcript is scrolled up, which is not worth a third
  // voice for the same fact.

  // Someone has this conversation OPEN in a terminal. That outranks the
  // listener count, which only sees an agent blocked in `wait` and so reads
  // zero for a human mid-thought - the state where the old line said "no
  // agent connected" about a session running two windows away.
  if (presence?.interactive) {
    const harness = attendant?.harness ?? "the agent";
    return (
      <div
        data-test="listener-line"
        data-presence="interactive"
        className="flex items-center justify-center gap-1.5 text-center"
      >
        <span className="size-1.5 flex-none bg-agent" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-test="mode-term"
                className="border-b border-dotted border-agent/40 text-[10px] uppercase tracking-[0.08em] text-agent"
              >
                {`running in ${harness}`}
                {presence.status ? ` · ${presence.status}` : ""}
              </span>
            }
          />
          <TooltipContent>
            {`That conversation is open in a terminal${presence.cwd ? ` (${presence.cwd})` : ""}. `}
            Your message goes to it - Lucid will not start a second process on the same session.
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (listening > 0) {
    return (
      <div
        data-test="listener-line"
        data-listening="true"
        className="flex items-center justify-center text-center text-[11px] text-agent"
      >
        {listening === 1 ? "agent listening" : `${listening} agents listening`}
      </div>
    );
  }

  // Nothing is running. What happens when you send depends entirely on whether
  // this hub attends: with attend on it RESUMES the recorded session headlessly
  // for one turn, which is a thing Lucid does - not a thing it waits for. The
  // old line ("delivered when one checks in") described the review-only hub and
  // was simply untrue here, implying some agent would wander back on its own.
  //
  // Named as a TERM with the explanation on hover, not a sentence: this sits
  // above the composer on every turn, and a line of prose that never changes
  // is a line of prose nobody reads after the first time.
  const harness = attendant?.harness ?? "the agent";
  // "Spawn mode" is a promise that sending starts a turn. It can only be kept
  // when a harness conversation exists to resume - an artifact nobody has
  // attended (hand-written, recovered from a backup) has none, and the engine
  // declines every time with "no harness session recorded". Announcing spawn
  // mode there left feedback sitting under a claim that a reply was coming.
  const spawnable = attend && resumable;
  return (
    <div
      data-test="listener-line"
      data-listening="false"
      data-mode={spawnable ? "spawn" : attend ? "unattached" : "recorded"}
      className="flex items-center justify-center text-center"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-test="mode-term"
              className="border-b border-dotted border-ink-500 text-[10px] uppercase tracking-[0.08em] text-fg-faint hover:text-fg"
            >
              {spawnable ? "spawn mode" : attend ? "no agent session" : "recording only"}
            </span>
          }
        />
        <TooltipContent>
          {spawnable
            ? `Nothing is running. Sending resumes ${harness} headlessly - one turn per send, on the model and effort picked below.`
            : attend
              ? "No agent conversation is recorded on this artifact, so there is nothing to resume - it was written by hand, or recovered from a backup. Your feedback is saved and the next agent that opens it reads everything waiting."
              : `Nothing is running, and this hub does not spawn agents. Feedback is recorded and delivered the next time ${harness} checks in. Start the hub with --attend to have it drive turns itself.`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

/**
 * The bottom of the panel, under the send button: who is on the other end, and
 * - when nobody is - the way to become them.
 *
 * The harness is named here ALWAYS, because it is standing information rather
 * than news: it belongs at the foot of the panel, not competing with the line
 * that reports what is happening right now. The resume command sits below it,
 * and only in the mode where resuming is a thing to do - with the conversation
 * already open, the command would offer a second process on one session.
 */
/**
 * The one place connection state is reported: at the composer, which is what a
 * dropped stream actually costs you - a submitted message that cannot land.
 *
 * It was in two places before (the artifact header AND the tab strip), which
 * described a single dropped stream twice, in the two corners furthest from the
 * box you had just typed into. Self-clearing: both streams retry themselves, so
 * this states what is happening and asks for nothing.
 */
const ConnectionLine = () => {
  const live = useSession((s) => s.live);
  const streamRetries = useSession((s) => s.streamRetries);
  const hubConnected = useHub((s) => s.connected);
  // A standalone per-session viewer has NO hub - its transport base is "",
  // where the shell's is "/s/<id>". Reporting a hub that was never there would
  // put a permanent "reconnecting" under every standalone composer.
  const hubHosted = useSessionHandle().transport.base !== "";
  // The session stream is the one that carries a turn, so it is named first;
  // the hub only matters here when the session itself is healthy.
  const what = !live ? "the live connection" : hubHosted && !hubConnected ? "the hub" : null;
  if (what === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-test="reconnecting"
            data-scope={live ? "hub" : "session"}
            // The counter belongs to the SESSION stream, so it is only
            // meaningful on a session-scoped pill; on a hub-scoped one it
            // would report 0 for a stream that is fine while the hub is not.
            {...(live ? {} : { "data-retries": streamRetries })}
            className="flex items-center justify-center gap-1.5 border-t border-ink-700 pt-2 text-[10px] text-steel-400"
          >
            <span className="inline-block size-1.5 flex-none bg-steel-400" />
            reconnecting to {what}…
          </span>
        }
      />
      <TooltipContent>{what} dropped; retrying automatically</TooltipContent>
    </Tooltip>
  );
};

const AttendanceFooter = () => {
  const status = useSession((s) => s.status);
  const presence = useSession((s) => s.attendantPresence);
  const attendant = useSession((s) => s.lastAttendant);
  if (status !== "active" || !attendant?.harness) return null;
  const interactive = presence?.interactive === true;
  return (
    <div className="flex flex-col items-center gap-1 border-t border-ink-700 pt-2">
      <span data-test="harness-line" className="text-[10px] text-fg-faint">
        {attendant.harness}
        {interactive ? " · interactive" : " · headless turns"}
      </span>
      {interactive ? null : <ResumeHint />}
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-test="resume-copy"
            aria-label="Copy the command that resumes this conversation"
            onClick={() => {
              navigator.clipboard.writeText(cmd).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                },
                () => notify.warn("Couldn't copy - the command is in this button's tooltip."),
              );
            }}
            // Centred with the footer, and quieter than the harness line above it:
            // this is an escape hatch to a terminal, not the way to use the panel.
            className="flex cursor-pointer items-center gap-1 self-center border border-ink-700 bg-ink-800 px-1.5 py-px font-mono text-[9px] tracking-tight text-fg-faint hover:border-ink-600 hover:text-fg"
          >
            {copied ? (
              // lucide check
              <svg
                viewBox="0 0 24 24"
                width="10"
                height="10"
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
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect width="14" height="14" x="8" y="8" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
            )}
            <span data-test="resume-copy-label">
              {copied ? "copied - paste it in a terminal" : "copy resume command"}
            </span>
          </button>
        }
      />
      {/* The command itself, which the chip's label no longer spells out - so
          it is readable before copying, not only after pasting. */}
      <TooltipContent className="font-mono">{cmd}</TooltipContent>
    </Tooltip>
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
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-test="scroll-bottom"
              aria-label="Scroll to the latest"
              disabled={atBottom}
              onClick={() => {
                const el = visibleEl('[data-test="thread-viewport"]');
                el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              }}
              className="pointer-events-auto flex size-8 cursor-pointer items-center justify-center border border-ink-400 bg-ink-800/95 text-fg shadow-[0_4px_14px_rgba(0,0,0,0.45)] hover:bg-ink-700 disabled:invisible"
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
          }
        />
        <TooltipContent>Scroll to the latest</TooltipContent>
      </Tooltip>
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
