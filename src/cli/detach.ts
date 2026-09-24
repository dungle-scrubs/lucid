import { HubError } from "../protocol/hub-errors.js";
import { openWriter } from "../store/conversation-host.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir, conversations } from "./record-addressing.js";

export interface DetachResult {
  readonly conversationId: string;
  readonly message: string;
}

/** Append a hold-released fact so the holding worker ends its hold at the
 * turn boundary. Idempotent: a repeat with the same intent reports the
 * recorded release. Refuses when no hold was ever recorded. */
export function requestDetach(rootDir: string | undefined, conversationId: string): DetachResult {
  const records: Conversations = conversations(rootDir);
  const host = openWriter(commandRecordDir(records, conversationId), {});
  try {
    if (host.state().holdRelease !== null)
      return { conversationId, message: "The hold is already released." };
    const written = host.writeConnection({
      actionId: crypto.randomUUID(),
      kind: "hold-released",
    });
    if (written.verdict === "refused")
      throw new HubError(`Detach refused: ${written.issue}.`, "E-HUB-03", 409);
    return {
      conversationId,
      message: "Detach requested. New inputs are held; the source leaves at the turn boundary.",
    };
  } finally {
    host.close();
  }
}
