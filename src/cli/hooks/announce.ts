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

import { openConversation, StoreError } from "../../store/store.js";
import { exitHook, guardHookEntry, readStdin } from "./delivery.js";

export interface AnnounceResult {
  readonly ok: boolean;
  readonly code?: "hook-resolution-failed";
  readonly message?: string;
}

export const announce = async (stdin: string): Promise<AnnounceResult> => {
  const guard = guardHookEntry(stdin);
  if (!guard.proceed) return guard.result as AnnounceResult;
  const { dir: recordDir, conversationId, secret } = guard.record;

  // Append attach (+ identity) via the store's lock-wrapped transaction.
  try {
    const host = openConversation(recordDir, {
      now: () => Date.now(),
      presence: () => true,
      // R2: the hook never holds the presence lock — attach is a write,
      // and its effects are the holder's to find (RFC-04).
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    const frame = {
      kind: "attach" as const,
      conversationId,
      secret,
      profile: "interactive" as const,
      version: 1,
    };
    const { encodeFrame } = await import("../../protocol/index.js");
    host.handleFrame(encodeFrame(frame as unknown as Parameters<typeof encodeFrame>[0]));
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
