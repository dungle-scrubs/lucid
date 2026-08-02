import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type PendingAttachment,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useMemo, type ReactNode } from "react";
import { useSession, useSessionHandle } from "./context.tsx";
import { deliveryState } from "./Delivery.tsx";
import { buildTimeline } from "./store.ts";
import type { TimelineItem } from "./types.ts";

/**
 * The bridge from Lucid's event log to assistant-ui.
 *
 * Lucid is not an LLM chat. The log is the source of truth, it arrives over
 * SSE, and the "assistant" is a CLI agent in another process that may reply
 * minutes later or never. ExternalStoreRuntime is built for exactly this: it
 * renders whatever `messages` holds and never assumes `onNew` produces a reply.
 */

export const LucidRuntimeProvider = ({ children }: { readonly children: ReactNode }) => {
  const session = useSessionHandle();
  const { transport, pastes, actions } = session;

  /**
   * Server-side filename per attachment id. The upload happens in `add` (the
   * agent reads bytes off disk, so they must land before the message does),
   * and `onNew` needs the stored filename back - which no field on Attachment
   * carries. Keyed by id rather than derived from contentType, because the
   * server decides the name and guessing it is how thumbs break. Per SESSION,
   * not module-wide: an attachment uploaded to one session's store must never
   * resolve through another session's transport and ride a message there.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` is the cache key, not a value read inside - a new session must start with an empty registry.
  const uploaded = useMemo(() => new Map<string, { name: string; file: string }>(), [session]);

  /**
   * assistant-ui has no thread item that is not a message, so an annotation is
   * carried as a message with a custom `data-annotation` part.
   *
   * `user`, for two reasons. Semantically an annotation is the human pointing
   * at a thing and saying what they mean - it is their turn, not the agent's.
   * And mechanically the alternatives are closed: `system` messages are
   * required to hold exactly one *text* part (fromThreadMessageLike throws
   * otherwise), and adjacent `assistant` messages are merged for display,
   * which would fuse an annotation into a neighbouring agent reply.
   *
   * Bound to the session for its asset URLs; memoized so the runtime sees a
   * stable function identity across renders.
   */
  const convertMessage = useMemo(
    () =>
      (item: TimelineItem): ThreadMessageLike => {
        if (item.kind === "queued") {
          // Client-side state riding the transcript: the card holds its
          // authored place in the record before the log knows about it. The
          // component reads the live queue by id, so edits re-render without
          // reconverting.
          return {
            role: "user",
            id: item.id,
            createdAt: new Date(item.at),
            content: [{ type: "data-queued", data: { id: item.id, index: item.index } }],
          } as ThreadMessageLike;
        }
        if (item.kind === "question") {
          // Question + answer as ONE item (D14). `user`, like an annotation:
          // it enters the record because the HUMAN answered, and the card
          // renders both halves itself.
          return {
            role: "user",
            id: `qa-${item.question.id}`,
            createdAt: new Date(item.at),
            content: [{ type: "data-qa", data: { id: item.question.id } }],
          } as ThreadMessageLike;
        }
        if (item.kind === "verdict") {
          // The record's own marker for "the review was settled here". Keyed by
          // the log seq so a reload rebuilds the same id.
          return {
            role: "user",
            id: `verdict-${item.verdict.seq}`,
            createdAt: new Date(item.at),
            content: [
              { type: "data-verdict", data: { resolved: item.verdict.resolved, at: item.at } },
            ],
          } as ThreadMessageLike;
        }
        if (item.kind === "annotation") {
          return {
            role: "user",
            id: item.annotation.id,
            createdAt: new Date(item.at),
            // Delivery state rides the MESSAGE, not the data part: the same
            // label renders on a message bubble, which has no data part to
            // carry it (D20).
            metadata: { custom: { delivery: deliveryState(item.annotation) } },
            content: [
              {
                type: "data-annotation",
                data: {
                  id: item.annotation.id,
                  index: item.index,
                  version: item.annotation.version,
                  note: item.annotation.note,
                  target: item.annotation.target,
                  targets: item.annotation.targets,
                  confidence: item.annotation.confidence,
                  images: item.annotation.images,
                },
              },
            ],
          } as ThreadMessageLike;
        }
        const m = item.message;
        return {
          role: m.role === "human" ? "user" : "assistant",
          // The event's own seq, never `${m.role}-${m.at}`: one timestamp is
          // stamped per APPEND at ms precision, so two messages in the same
          // millisecond collided into one id - and a duplicate id makes
          // assistant-ui throw and take the entire viewer down with it.
          id: `${m.role}-${m.seq}`,
          createdAt: new Date(m.at),
          // The agent's own turn has nowhere to be delivered to, so it
          // carries no state rather than a meaningless "recorded".
          ...(m.role === "human" ? { metadata: { custom: { delivery: deliveryState(m) } } } : {}),
          content: [
            ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
            ...(m.images ?? []).map((img) => ({
              type: "image" as const,
              image: transport.assetUrl(img.file),
            })),
          ],
        };
      },
    [transport],
  );

  const attachmentAdapter = useMemo(
    (): AttachmentAdapter => ({
      accept: "image/*",
      async add({ file }): Promise<PendingAttachment> {
        const meta = await transport.uploadAsset(file);
        uploaded.set(meta.id, { name: meta.name, file: meta.file });
        return {
          id: meta.id,
          type: "image",
          name: meta.name,
          contentType: file.type,
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
      },
      async remove(attachment) {
        uploaded.delete(attachment.id);
        /* the blob stays on disk; an unsent paste is not worth a delete round trip */
      },
      async send(attachment) {
        const meta = uploaded.get(attachment.id);
        return {
          ...attachment,
          status: { type: "complete" },
          content: meta ? [{ type: "image", image: transport.assetUrl(meta.file) }] : [],
        };
      },
    }),
    [transport, uploaded],
  );

  // Memoized on the slices it reads: the runtime re-renders on every
  // `messages` identity change, so a freshly-built array each render is an
  // infinite loop (React #185).
  const annotations = useSession((s) => s.annotations);
  const messages = useSession((s) => s.messages);
  const queue = useSession((s) => s.queue);
  const sending = useSession((s) => s.sending);
  const questions = useSession((s) => s.questions);
  const verdicts = useSession((s) => s.verdicts);
  const timeline = useMemo(
    () => buildTimeline(annotations, messages, queue, questions, verdicts),
    [annotations, messages, queue, questions, verdicts],
  );

  /**
   * Records the message and returns. No assistant message follows synchronously
   * - the agent replies on its own schedule, and the reply reaches us through
   * the SSE tail like any other log event.
   *
   * assistant-ui empties the composer before it calls this, so by now the
   * human's typing is gone from the only place it lived. Nothing here may risk
   * it: the message goes into the (persisted) outbox first, and the network is
   * touched only after. A failed send therefore leaves a card to retry, not a
   * warning about text nobody has any more.
   */
  const onNew = async (message: AppendMessage): Promise<void> => {
    // A `[Pasted text #N +L lines]` placeholder leaves the composer as the
    // full paste it stands for: the collapse is input ergonomics, and the
    // agent must read what was actually pasted.
    const raw = message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    const text = pastes.expandPastes(raw).trim();
    const images = (message.attachments ?? []).flatMap((a) => {
      const meta = uploaded.get(a.id);
      return meta ? [{ id: a.id, name: meta.name, file: meta.file }] : [];
    });
    if (text.length === 0 && images.length === 0) return;
    actions.enqueueMessage(text, images);
    // Both are safe to retire now: the outbox holds the expanded text, and the
    // uploads it references are already on disk under their stored names. The
    // paste map is session-local, so keeping placeholders alive for a retry
    // would only make the retry weaker than the entry it retries.
    pastes.consumePastes(raw);
    for (const a of message.attachments ?? []) uploaded.delete(a.id);
    await actions.flushOutbox();
  };

  const runtime = useExternalStoreRuntime({
    messages: timeline,
    convertMessage,
    // Explicit: omitting this makes assistant-ui infer "running" from the last
    // message's status, which is meaningless here - the agent's work happens in
    // another process with no message in flight.
    isRunning: sending,
    onNew,
    adapters: { attachments: attachmentAdapter },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};
