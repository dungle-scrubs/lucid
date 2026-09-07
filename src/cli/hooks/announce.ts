/**
 * `lucid announce` - SessionStart hook (M2.3, D-014).
 *
 * Reads the SessionStart payload from stdin, resolves the record via
 * the env-stamp (`LUCID_RECORD_DIR`), verifies identity against
 * `meta.json`, and appends `attach` (+ identity) on a match. On a
 * `meta.json` mismatch it exits non-destructively (E003), never writes
 * the wrong record.
 *
 * What it is NOT: it does not create a record, does not hold the
 * presence lock beyond the attach transaction, and does not depend on
 * the Stop hook.
 */

import { nativeOwner } from "../../harness/native-owner.js";
import { guardHookEntry, parseAnnouncePayload } from "../../modes/interactive-host.js";
import { EventKind } from "../../protocol/events.js";
import { createTurnIds } from "../../protocol/turn-id.js";
import { openWriter, StoreError } from "../../store/store.js";
import { exitHook, readStdin } from "./delivery.js";

export interface AnnounceResult {
  readonly ok: boolean;
  readonly code?: "hook-resolution-failed";
  readonly message?: string;
}

export const announce = async (stdin: string): Promise<AnnounceResult> => {
  const guard = guardHookEntry(stdin);
  if (!guard.proceed) return guard.result as AnnounceResult;
  const { dir: recordDir, conversationId, secret } = guard.record;
  const input = parseAnnouncePayload(guard.payload);
  if (input === null)
    return { ok: false, code: "hook-resolution-failed", message: "Invalid SessionStart payload" };
  const owner = await nativeOwner("claude");

  // Append attach (+ identity) via the store's lock-wrapped transaction.
  try {
    const host = openWriter(recordDir, { presence: () => true });
    const frame = {
      kind: "attach" as const,
      conversationId,
      secret,
      profile: "interactive" as const,
      version: 1,
      harness: "claude" as const,
      ...(owner === undefined ? {} : { owner }),
    };
    const { encodeFrame } = await import("../../protocol/index.js");
    try {
      const attached = host.handleFrame(encodeFrame(frame));
      if (attached.verdict === "refused")
        return {
          ok: false,
          code: "hook-resolution-failed",
          message: `attach refused: ${attached.issue}`,
        };
      const identity = host.handleFrame(
        encodeFrame({
          kind: "event",
          epoch: attached.state.epoch,
          n: 1,
          turnId: createTurnIds()(),
          event: {
            kind: EventKind.identity,
            sessionId: input.sessionId,
            authority: "harness-minted",
          },
        }),
      );
      if (identity.verdict === "refused")
        return {
          ok: false,
          code: "hook-resolution-failed",
          message: `identity refused: ${identity.issue}`,
        };
    } finally {
      host.close();
    }
  } catch (e) {
    if (e instanceof StoreError) {
      // A store error during attach is a hook-resolution failure
      // (e.g., corrupt log) - exit non-destructively.
      return { ok: false, code: "hook-resolution-failed", message: e.message };
    }
    throw e;
  }

  return { ok: true };
};

/** CLI entry: read stdin, run announce, exit with appropriate code. */
export const runAnnounce = async (): Promise<void> => {
  const stdin = await readStdin();
  const result = await announce(stdin);
  exitHook(result);
};
