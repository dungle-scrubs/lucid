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

import type { encodeFrame } from "../../protocol/index.js";
import { openConversation, StoreError } from "../../store/store.js";
import { resolveVerifiedRecord } from "./resolver.js";

export interface AnnounceResult {
  readonly ok: boolean;
  readonly code?: "hook-resolution-failed";
  readonly message?: string;
}

export const announce = async (stdin: string): Promise<AnnounceResult> => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    // Non-JSON stdin is a hook misfire; exit non-destructively.
    return { ok: true };
  }

  const resolved = resolveVerifiedRecord();
  if ("notManaged" in resolved) {
    // No stamp - the session is not a lucid-managed one; do nothing.
    return { ok: true };
  }
  if (!resolved.ok) {
    // E003: hook-resolution-failure - exit non-destructively, never
    // write the wrong record.
    return { ok: false, code: resolved.code, message: resolved.message };
  }
  const { dir: recordDir, conversationId, secret } = resolved.record;

  // Append attach (+ identity) via the store's lock-wrapped transaction.
  try {
    const host = openConversation(recordDir, {
      now: () => Date.now(),
      presence: () => true,
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
    // Use the host's handleFrame path so the secret is redacted and the
    // log is the seq authority.
    const _line = JSON.stringify(frame);
    // The frame must be encoded via the protocol's wire format; but for
    // the store host we can pass the raw JSON string - the host will
    // decode it. To include the version, we use the same shape as the
    // test helper.
    const { encodeFrame } = await import("../../protocol/index.js");
    host.handleFrame(encodeFrame(frame as unknown as Parameters<typeof encodeFrame>[0]));
    void payload;
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const stdin = Buffer.concat(chunks).toString("utf8");
  const result = await announce(stdin);
  if (!result.ok) {
    process.stderr.write(`announce: ${result.code}: ${result.message}\n`);
    process.exit(0); // non-destructive exit, never writes wrong record
  }
  process.exit(0);
};
