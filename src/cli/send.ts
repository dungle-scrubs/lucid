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

import { join } from "node:path";
import { createConversationRecord, openConversation } from "../store/store.js";

export interface SendOpts {
  readonly rootDir?: string;
  readonly text: string;
}

/** Append `text` as a transient `input` to `conversationId`'s log.
 * Creates the record if it does not exist (first send mints it).
 * Returns the enqueued input id so a test can assert at-least-once. */
export const sendInput = (conversationId: string, opts: SendOpts): { inputId: string } => {
  const rootDir = opts.rootDir ?? defaultRoot();
  const recordDir = join(rootDir, conversationId);

  // Ensure the record exists; `lucid send` before any `lucid run` is
  // allowed to mint it (the first attacher never mints, but the first
  // sender may - this matches the CLI's role as an entry point).
  let secret: string | undefined;
  try {
    const created = createConversationRecord(rootDir, conversationId);
    secret = created.secret;
  } catch (e) {
    if (!(e instanceof Error) || !/exists/.test(e.message)) throw e;
  }

  const host = openConversation(recordDir, {
    now: () => Date.now(),
    presence: () => undefined,
    onEffect: () => {},
    onRecord: () => {},
  });

  const inputId = `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  host.enqueueInput({ id: inputId, text: opts.text, mode: "queue" });

  // Secret is only needed for the initial attach case above; for a
  // pure input append the host's fold already knows the secret from
  // the 0600 file, so we do not need to keep it.

  void secret;
  return { inputId };
};

const defaultRoot = (): string => {
  const fromEnv = process.env.LUCID_ROOT;
  if (fromEnv) return fromEnv;
  // The substrate's default is a temp-like root; for the CLI we fall
  // back to a conventional location under the user's data dir.
  return join(process.env.HOME ?? "/tmp", ".lucid", "records");
};
