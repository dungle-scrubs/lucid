import { HubError } from "../protocol/hub-errors.js";
import { openWriter } from "../store/conversation-host.js";
import { readRecordMetadata } from "../store/record-identity.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir, conversations } from "./record-addressing.js";

export interface DetachResult {
  readonly conversationId: string;
  readonly message: string;
}

/** Append a hold-released fact so the holding worker ends its hold at the
 * turn boundary. Idempotent: a repeat with the same intent reports the
 * recorded release. Refuses when the record is native-bound (no hold to
 * release) or when no hold was ever recorded. */
export function requestDetach(rootDir: string | undefined, conversationId: string): DetachResult {
  const records: Conversations = conversations(rootDir);
  const dir = commandRecordDir(records, conversationId);
  const host = openWriter(dir, {});
  try {
    const state = host.state();
    if (state.connection?.binding !== undefined || state.nativePublication !== null)
      throw new HubError(
        "This conversation is natively bound; there is no review hold to release.",
        "E-HUB-03",
        409,
      );
    let handoff = false;
    try {
      handoff = readRecordMetadata(dir).handoff === true;
    } catch {
      /* Unreadable metadata means no marker. */
    }
    if (state.holdRelease !== null)
      return { conversationId, message: "The hold is already released." };
    // The marker proves handoff origin; a past attachment proves a hold
    // existed to release. A marked record no worker ever joined refuses.
    if (!handoff || state.epoch === 0)
      throw new HubError(
        "This conversation never held a review hold; there is nothing to release.",
        "E-HUB-03",
        409,
      );
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
