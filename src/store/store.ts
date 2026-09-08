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

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  pathsForDir,
  type RecordPaths,
  recordPaths,
  StoreError,
  validConversationId,
} from "./errors.js";

import { associateFolder } from "./project-directory.js";

export interface CreateRecordOptions {
  readonly workingDirectory?: string | null;
  readonly preference?: import("./driver-preference.js").DriverPreference;
  readonly creation?: { readonly id: string; readonly request: unknown };
}

const SECRET_BYTES = 32;

export { pathsForDir, type RecordPaths, recordPaths, StoreError, validConversationId };

export const createConversationRecord = (
  rootDir: string,
  conversationId: string,
  options: CreateRecordOptions = {},
): { readonly secret: string; readonly paths: RecordPaths } => {
  if (!validConversationId(conversationId))
    throw new StoreError(
      "invalid-conversation-id",
      `conversation id is not a safe path component: ${JSON.stringify(conversationId)}`,
    );
  const paths = recordPaths(rootDir, conversationId);
  if (existsSync(paths.dir))
    throw new StoreError("record-exists", `conversation record already exists: ${paths.dir}`);
  const association =
    options.workingDirectory == null ? {} : associateFolder(options.workingDirectory);
  mkdirSync(rootDir, { recursive: true });
  const staging = mkdtempSync(join(rootDir, ".create-"));
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("hex");
  try {
    const tmp = pathsForDir(staging);
    const workspace = options.workingDirectory === null ? join(staging, "workspace") : null;
    if (workspace) mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(tmp.secretPath, secret, { mode: 0o600 });
    writeFileSync(tmp.logPath, "", { mode: 0o600 });
    if (options.preference)
      writeFileSync(tmp.driverPath, JSON.stringify(options.preference), { mode: 0o600 });
    writeFileSync(
      tmp.metaPath,
      JSON.stringify({
        v: 1,
        conversationId,
        ...association,
        ...(workspace
          ? {
              managedWorkspace: true,
              workingDirectory: join(realpathSync(rootDir), conversationId, "workspace"),
            }
          : {}),
        ...(options.creation ? { creation: options.creation } : {}),
      }),
      {
        mode: 0o600,
      },
    );
    for (const path of [
      tmp.secretPath,
      tmp.logPath,
      tmp.metaPath,
      ...(options.preference ? [tmp.driverPath] : []),
      ...(workspace ? [workspace] : []),
      staging,
    ]) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(staging, paths.dir);
    const rootFd = openSync(rootDir, "r");
    try {
      fsyncSync(rootFd);
    } finally {
      closeSync(rootFd);
    }
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    throw new StoreError("record-publish-failed", `could not publish record at ${paths.dir}`, {
      cause,
    });
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
  openWriter,
  type RecoveryRecord,
  type ViewSnapshot,
  viewConversation,
  viewSnapshot,
  type WireRecord,
} from "./conversation-host.js";
export type {
  AppendEvent,
  ArtifactIndex,
  ArtifactRefusal,
  ArtifactVersion,
  CollectedBatch,
  CollectedEntry,
  LogEntry,
  Transcript,
  TranscriptEvent,
  TranscriptInput,
} from "./log.js";
export {
  ARTIFACT_BYTES_MAX,
  collectEffectsUnderAppendLock,
  foldCollect,
  hashArtifactBytes,
  readArtifactAtOffset,
  readArtifactVersion,
} from "./log.js";
