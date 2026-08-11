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

import { openConversation } from "../store/store.js";
import { conversations } from "./conversations.js";

export interface SendOpts {
  readonly rootDir?: string;
  readonly text: string;
}

/** Append `text` as a transient `input` to `conversationId`'s log.
 * Creates the record if it does not exist (first send mints it).
 * Returns the enqueued input id so a test can assert at-least-once. */
export const sendInput = (conversationId: string, opts: SendOpts): { inputId: string } => {
  const convs = conversations(opts.rootDir);
  const { dir: recordDir } = convs.ensure(conversationId);

  const host = openConversation(recordDir, {
    now: () => Date.now(),
    presence: () => undefined,
    onEffect: () => {},
    onRecord: () => {},
  });

  const inputId = `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  host.enqueueInput({ id: inputId, text: opts.text, mode: "queue" });
  return { inputId };
};
