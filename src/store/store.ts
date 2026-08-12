/**
 * The durable conversation store — thin shell that re-exports the deep
 * `ConversationHost` discipline (Candidate 1).
 *
 * The host discipline (secret load + `transact` seam + redaction +
 * recovery + single snapshot derivation) now lives in
 * `src/store/conversation-host.ts`. The mint (`createConversationRecord`)
 * remains here — it is the record-creation concern, not the host concern.
 * `openConversation` / `viewConversation` / `viewSnapshot` are preserved
 * as thin adapters so existing call sites keep their import path while
 * the deep module is the single owner.
 *
 * What it is NOT: transport, rendering, or the flock primitive.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pathsForDir,
  type RecordPaths,
  recordPaths,
  StoreError,
  validConversationId,
} from "./errors.js";

const SECRET_BYTES = 32;
const _REDACTED = "redacted";

export { pathsForDir, type RecordPaths, recordPaths, StoreError, validConversationId };

export const createConversationRecord = (
  rootDir: string,
  conversationId: string,
): { readonly secret: string; readonly paths: RecordPaths } => {
  if (!validConversationId(conversationId))
    throw new StoreError(
      "invalid-conversation-id",
      `conversation id is not a safe path component: ${JSON.stringify(conversationId)}`,
    );
  const paths = recordPaths(rootDir, conversationId);
  if (existsSync(paths.dir))
    throw new StoreError("record-exists", `conversation record already exists: ${paths.dir}`);
  mkdirSync(rootDir, { recursive: true });
  const staging = mkdtempSync(join(rootDir, ".create-"));
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("hex");
  try {
    const tmp = pathsForDir(staging);
    writeFileSync(tmp.secretPath, secret, { mode: 0o600 });
    writeFileSync(tmp.logPath, "", { mode: 0o600 });
    writeFileSync(tmp.metaPath, JSON.stringify({ v: 1, conversationId }), { mode: 0o600 });
    renameSync(staging, paths.dir);
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    throw new StoreError("record-exists", `could not publish record at ${paths.dir}`, { cause });
  }
  return { secret, paths };
};

// Deep host re-exports — the single owner now lives in `conversation-host.ts`
export {
  type ConversationHost,
  createConversationHost,
  type HostDeps,
  type HostRecord,
  type HostSnapshot,
  openConversation,
  type RecoveryRecord,
  type ViewSnapshot,
  viewConversation,
  viewSnapshot,
  type WireRecord,
} from "./conversation-host.js";
export type { AppendEvent, LogEntry, Transcript, TranscriptEvent, TranscriptInput } from "./log.js";
