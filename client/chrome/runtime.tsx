import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type PendingAttachment,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useMemo, type ReactNode } from "react";
import { api, buildTimeline, useLucid, uuid, warn } from "./store.ts";
import type { TimelineItem } from "./types.ts";

/**
 * The bridge from Lucid's event log to assistant-ui.
 *
 * Lucid is not an LLM chat. The log is the source of truth, it arrives over
 * SSE, and the "assistant" is a CLI agent in another process that may reply
 * minutes later or never. ExternalStoreRuntime is built for exactly this: it
 * renders whatever `messages` holds and never assumes `onNew` produces a reply.
 */

/**
 * assistant-ui has no thread item that is not a message, so an annotation is
 * carried as a message with a custom `data-annotation` part.
 *
 * `user`, for two reasons. Semantically an annotation is the human pointing at
 * a thing and saying what they mean - it is their turn, not the agent's. And
 * mechanically the alternatives are closed: `system` messages are required to
 * hold exactly one *text* part (fromThreadMessageLike throws otherwise), and
 * adjacent `assistant` messages are merged for display, which would fuse an
 * annotation into a neighbouring agent reply.
 */
const convertMessage = (item: TimelineItem): ThreadMessageLike => {
  if (item.kind === "annotation") {
    return {
      role: "user",
      id: item.annotation.id,
      createdAt: new Date(item.at),
      content: [
        {
          type: "data-annotation",
          data: {
            id: item.annotation.id,
            index: item.index,
            version: item.annotation.version,
            note: item.annotation.note,
            target: item.annotation.target,
            images: item.annotation.images,
          },
        },
      ],
    } as ThreadMessageLike;
  }
  const m = item.message;
  return {
    role: m.role === "human" ? "user" : "assistant",
    id: `${m.role}-${m.at}`,
    createdAt: new Date(m.at),
    content: [
      ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
      ...(m.images ?? []).map((img) => ({
        type: "image" as const,
        image: `/__lucid/asset/${img.file}`,
      })),
    ],
  };
};

/**
 * Server-side filename per attachment id. The upload happens in `add` (the
 * agent reads bytes off disk, so they must land before the message does), and
 * `onNew` needs the stored filename back - which no field on Attachment
 * carries. Keyed by id rather than derived from contentType, because the
 * server decides the name and guessing it is how thumbs break.
 */
const uploaded = new Map<string, { name: string; file: string }>();

const attachmentAdapter: AttachmentAdapter = {
  accept: "image/*",
  async add({ file }): Promise<PendingAttachment> {
    const upload = await fetch("/__lucid/asset", {
      method: "POST",
      headers: { "content-type": file.type, "x-lucid-filename": file.name || "pasted" },
      body: file,
    });
    if (!upload.ok) throw new Error("upload failed");
    const meta = (await upload.json()) as { id: string; name: string; file: string };
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
      content: meta ? [{ type: "image", image: `/__lucid/asset/${meta.file}` }] : [],
    };
  },
};

export const LucidRuntimeProvider = ({ children }: { readonly children: ReactNode }) => {
  // Memoized on the two slices it reads: the runtime re-renders on every
  // `messages` identity change, so a freshly-built array each render is an
  // infinite loop (React #185).
  const annotations = useLucid((s) => s.annotations);
  const messages = useLucid((s) => s.messages);
  const sending = useLucid((s) => s.sending);
  const timeline = useMemo(() => buildTimeline(annotations, messages), [annotations, messages]);

  /**
   * Posts and returns. No assistant message follows synchronously - the agent
   * replies on its own schedule, and the reply reaches us through the SSE tail
   * like any other log event.
   */
  const onNew = async (message: AppendMessage): Promise<void> => {
    const text = message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();
    const images = (message.attachments ?? []).flatMap((a) => {
      const meta = uploaded.get(a.id);
      if (!meta) return [];
      uploaded.delete(a.id);
      return [{ id: a.id, name: meta.name, file: meta.file }];
    });
    if (text.length === 0 && images.length === 0) return;
    try {
      await api("/__lucid/message", { id: uuid(), text, refs: [], images });
    } catch {
      warn("Your message didn't send - try again.");
    }
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
