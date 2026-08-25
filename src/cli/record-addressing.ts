/**
 * RecordAddressing — the deep module that owns `stamp -> dir -> verified identity -> secret`.
 *
 * Before, three seams each owned a slice: `conversations.ts` owned
 * `process.env.LUCID_ROOT -> join(root, conversationId)` + the
 * `createConversationRecord` fallback, `env-stamp.ts` owned the
 * `LUCID_RECORD_DIR` hint + `readStamp/resolveRecordDir/selfInvocation`,
 * and `hooks/resolver.ts` owned `verifyRecord/loadSecret/resolveVerifiedRecord`
 * (E003: "never write the wrong record" - D-010). Fixing a trust-boundary
 * edge (stale basename, missing meta, unreadable secret) required bouncing
 * across two files, and the two `verifyRecord` copies had already diverged
 * (announce carried a stale-basename guard inject did not). `send`,
 * `watch`, `run`, and every hook re-derived `LUCID_ROOT` or
 * `LUCID_RECORD_DIR` independently — shotgun surgery across
 * `conversations + env-stamp + resolver + store/errors` (three reads,
 * three test files).
 *
 * Now one module owns the whole discipline — record-root resolution
 * (once), the stamp interpretation, `meta.json` verification, secret
 * loading, and the `Conversations` seam (`dirFor/pathsFor/ensure`) —
 * and hides it behind a small, deep interface. Consumers become thin
 * adapters: a hook is `guardHookEntry -> VerifiedRecord`, a CLI command
 * is `conversations(rootDir).ensure(id)`, and the stamp file is never
 * re-derived. The deletion test passes: deleting this module would
 * scatter `LUCID_ROOT` reads, `join(root,id)`, `LUCID_RECORD_DIR`
 * interpretation, `meta.json` parse, and `secret` load across every
 * command and every hook (including the future Stop hook).
 *
 * What it is NOT: it does not know the frame codec, the log, the
 * flock, or the hook delivery pipeline — it is the address, not the
 * transport.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConversationRecord, type RecordPaths, recordPaths } from "../store/store.js";

// ---------------------------------------------------------------------------
// Stamp constants + helpers (from env-stamp.ts)
// ---------------------------------------------------------------------------

export const LUCID_RECORD_DIR = "LUCID_RECORD_DIR";
export const LUCID_TURN_ID = "LUCID_TURN_ID";

/** Build the env object for a child spawn that should carry the stamp. */
export const envStamp = (recordDir: string, turnId?: string): NodeJS.ProcessEnv => ({
  [LUCID_RECORD_DIR]: recordDir,
  ...(turnId ? { [LUCID_TURN_ID]: turnId } : {}),
});

/** Read the stamp from the current env. Returns undefined when not set. */
export const readStamp = (): { recordDir: string; turnId?: string } | undefined => {
  const dir = process.env[LUCID_RECORD_DIR];
  if (!dir || dir.length === 0) return undefined;
  const turnId = process.env[LUCID_TURN_ID];
  return { recordDir: dir, ...(turnId ? { turnId } : {}) };
};

/** Resolve a record directory from the stamp or an explicit argument. */
export const resolveRecordDir = (explicitDir?: string): string | undefined => {
  if (explicitDir) return explicitDir;
  const stamp = readStamp();
  return stamp?.recordDir;
};

/**
 * Reconstruct how to re-invoke this CLI as a child process, in exec-form.
 * Uses `process.execPath` + `process.argv[1]` when running via `bun run
 * src/cli/main.ts`, otherwise just the exec path. Never a shell string.
 */
export const selfInvocation = (extraArgs: readonly string[] = []): readonly string[] => {
  const execPath = process.execPath;
  const arg1 = process.argv[1];
  if (arg1 && (arg1.endsWith(".ts") || arg1.endsWith(".js"))) {
    return [execPath, arg1, ...extraArgs];
  }
  return [execPath, ...extraArgs];
};

// ---------------------------------------------------------------------------
// Record path + verification (from resolver.ts + store/errors.ts shape)
// ---------------------------------------------------------------------------

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
 * points to a real, readable record. This is the E003 guard: on failure
 * the hook exits non-destructively and never writes the wrong record.
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

// ---------------------------------------------------------------------------
// Conversations seam (from conversations.ts)
// ---------------------------------------------------------------------------

export interface Conversations {
  readonly rootDir: string;
  /** Resolve the record directory for `conversationId`. Pure. */
  dirFor(conversationId: string): string;
  /** Resolve the full `RecordPaths` for `conversationId`. Pure. */
  pathsFor(conversationId: string): RecordPaths;
  /** Ensure the record exists, creating it if needed. Returns the
   *  secret (minted or existing) and the dir. */
  ensure(conversationId: string): { secret: string; dir: string };
}

/** Records live under `~/.lucid2/records` by default, overridden by
 * `LUCID_ROOT`.
 *
 * Not `~/.lucid`: that is v1's live state directory — its hub log, its
 * registry, its roots — and v1 is still in use. Defaulting there put a
 * `records/` subdirectory inside a running program's own directory. */
export const conversations = (rootDir?: string): Conversations => {
  const root =
    rootDir ?? process.env.LUCID_ROOT ?? join(process.env.HOME ?? "/tmp", ".lucid2", "records");
  return {
    rootDir: root,
    dirFor: (conversationId: string) => join(root, conversationId),
    pathsFor: (conversationId: string) => recordPaths(root, conversationId),
    ensure: (conversationId: string) => {
      try {
        const created = createConversationRecord(root, conversationId);
        return { secret: created.secret, dir: created.paths.dir };
      } catch (e) {
        if (!(e instanceof Error) || !/exists/.test(e.message)) throw e;
        const secretPath = join(root, conversationId, "secret");
        if (!existsSync(secretPath)) throw e;
        const secret = readFileSync(secretPath, "utf8").trim();
        return { secret, dir: join(root, conversationId) };
      }
    },
  };
};

export type { RecordPaths } from "../store/errors.js";
// Keep `recordPaths` and the validation helper surfaced here so callers
// that only need addressing don't deep-import `store/errors`. Thin
// re-exports stay here as the single import site; `store/errors` remains
// canonical for the store's own boundary.
export { pathsForDir, recordPaths, validConversationId } from "../store/errors.js";
