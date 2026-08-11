/**
 * HookRecordResolver — the deep module that owns `stamp -> dir -> verified identity -> secret`.
 *
 * Both `announce` (SessionStart) and `inject` (PostToolUse) previously
 * re-derived the same three steps: read `LUCID_RECORD_DIR`, verify
 * `meta.json`, and load the `secret`. The two `verifyRecord` copies had
 * already diverged (announce carried a stale-basename guard inject did
 * not). Fixing the E003 trust-boundary check ("never write the wrong
 * record" - D-010) required two edits and the bug hid in howhelpers are
 * called, not in a pure function.
 *
 * Now one module owns the whole discipline. The hooks become thin
 * adapters over the same interface. Fixing verification fixes every hook
 * (including the future Stop hook). The deletion test passes: deleting
 * this module would scatter env -> verify -> secret across every hook.
 *
 * What it is NOT: it does not know the frame codec, the log, or the
 * append. It is a resolver, not a writer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LUCID_RECORD_DIR } from "../env-stamp.js";

export interface VerifiedRecord {
  readonly dir: string;
  readonly conversationId: string;
  readonly secret: string;
}

export type ResolverResult =
  | { readonly ok: true; readonly record: VerifiedRecord }
  | { readonly ok: true; readonly notManaged: true }
  | { readonly ok: false; readonly code: "hook-resolution-failed"; readonly message: string };

/**
 * Verify that `recordDir` looks like a lucid record: `meta.json` exists,
 * is parseable, and carries a non-empty `conversationId`. Identity lives
 * in `meta.json`, not the path (a moved record still opens under its own
 * id), so basename mismatches are tolerated — the check is that the stamp
 * points to a real, readable record, not that the directory name matches.
 * This is the E003 guard: on failure the hook exits non-destructively and
 * never writes the wrong record.
 */
export const verifyRecord = (recordDir: string): { conversationId: string } | { error: string } => {
  const metaPath = join(recordDir, "meta.json");
  if (!existsSync(metaPath)) return { error: `no meta.json at ${metaPath}` };
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      conversationId?: string;
    };
    if (typeof meta.conversationId !== "string" || meta.conversationId.length === 0)
      return { error: "meta.json missing conversationId" };
    return { conversationId: meta.conversationId };
  } catch (e) {
    return { error: `could not read meta.json: ${e}` };
  }
};

/**
 * Load the record's secret (the host's credential). The secret file must
 * exist and be non-empty after trimming. Hex validation is deferred to
 * `openConversation` which owns the credential shape.
 */
export const loadSecret = (recordDir: string): { secret: string } | { error: string } => {
  const secretPath = join(recordDir, "secret");
  if (!existsSync(secretPath)) return { error: "no secret in record dir" };
  try {
    const secret = readFileSync(secretPath, "utf8").trim();
    if (secret.length === 0) return { error: "no secret in record dir" };
    return { secret };
  } catch (e) {
    return { error: `could not read secret: ${e}` };
  }
};

/**
 * Resolve the record hinted by the env-stamp (`LUCID_RECORD_DIR`) into a
 * verified `{dir, conversationId, secret}`.
 *
 * - No stamp (empty env): the session is not a lucid-managed one — not an
 *   error, the hook is a no-op. Returns `{ok: true, notManaged: true}`.
 * - Stale/invalid stamp (missing meta, unreadable meta, missing secret):
 *   a typed `hook-resolution-failed` failure — the hook exits
 *   non-destructively and never writes the wrong record (E003).
 * - Success: verified identity + secret.
 *
 * The single place that interprets `LUCID_RECORD_DIR` and the single place
 * that verifies it — so `env-stamp.ts`'s `readStamp`/`resolveRecordDir`
 * are no longer re-derived in the hooks.
 */
export const resolveVerifiedRecord = (): ResolverResult => {
  const dir = process.env[LUCID_RECORD_DIR];
  if (!dir || dir.length === 0) return { ok: true, notManaged: true };
  const verified = verifyRecord(dir);
  if ("error" in verified)
    return { ok: false, code: "hook-resolution-failed", message: verified.error };
  const secretResult = loadSecret(dir);
  if ("error" in secretResult)
    return { ok: false, code: "hook-resolution-failed", message: secretResult.error };
  return {
    ok: true,
    record: { dir, conversationId: verified.conversationId, secret: secretResult.secret },
  };
};
