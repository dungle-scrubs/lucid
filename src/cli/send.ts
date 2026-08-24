/**
 * `lucid send`: the short-lived transient input append.
 *
 * Appends a human input to the conversation's log via the lock-wrapped
 * store transaction. The input is folded by the NEXT `lucid run` (not
 * delivered live, D-011) - this command does not dispatch, hold a
 * presence lock, or tail. It is the direct-append path that still races
 * on the append lock, so two `lucid send`s concurrent with a `run`'s
 * append are serialized by the flock, not by torn lines.
 *
 * What it is NOT: it is not the live-delivery follow-tailer (deferred,
 * D-011), not a session creator, and not a viewer.
 */

import { createConversationHost } from "../store/conversation-host.js";
import { type Conversations, conversations } from "./record-addressing.js";

export interface SendOpts {
  readonly rootDir?: string;
  readonly text: string;
  /** Injected seams — CliHost provides the single `effectiveRoot`-bound factory so adapters don't re-derive `conversations(rootDir)`. */
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
  readonly createHostFn?: typeof createConversationHost;
  readonly now?: () => number;
  readonly makeId?: () => string;
}

/** Append `text` as a transient `input` to `conversationId`'s log.
 * Creates the record if it does not exist (first send mints it).
 * Returns the enqueued input id so a test can assert at-least-once.
 *
 * The addressing seam (`conversations`) and host creation are injected so
 * `dispatch` — the deep CliHost — owns the single `effectiveRoot`
 * resolution. The adapter is thin: ensure → host → enqueue. Deleting the
 * host would scatter LUCID_ROOT reads and secret-load across adapters.
 */
export const sendInput = (conversationId: string, opts: SendOpts): { inputId: string } => {
  const convsFactory = opts.conversationsFactory ?? conversations;
  const convs = convsFactory(opts.rootDir);
  const { dir: recordDir } = convs.ensure(conversationId);

  const createHost = opts.createHostFn ?? createConversationHost;
  const host = createHost(recordDir, {
    now: opts.now ?? (() => Date.now()),
    presence: () => undefined,
    // R2: `send` never acquires the presence lock, so it acts on none of
    // the effects its own append produces — the live holder's catch-up
    // fold finds them (RFC-04).
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });

  const inputId = opts.makeId?.() ?? `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  host.enqueueInput({ id: inputId, text: opts.text, mode: "queue" });
  return { inputId };
};
