/**
 * Shared store errors and record layout - extracted to break the
 * circular dependency between `store.ts` (the reducer host) and
 * `log.ts` (the deep log module). Both import from here; neither
 * imports the other for these types.
 */

import { join } from "node:path";

export class StoreError extends Error {
  override readonly name = "StoreError";
  constructor(
    readonly code:
      | "record-exists"
      | "invalid-conversation-id"
      | "missing-secret"
      | "invalid-secret"
      | "corrupt-log"
      | "fold-refused"
      | "append-failed",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RecordPaths {
  readonly dir: string;
  readonly secretPath: string;
  readonly logPath: string;
  readonly metaPath: string;
  /** The driver preference (RFC-12). Absent until a person makes a choice. */
  readonly driverPath: string;
  readonly lockPath: string;
}

export const pathsForDir = (dir: string): RecordPaths => {
  const logPath = join(dir, "log.ndjson");
  return {
    dir,
    secretPath: join(dir, "secret"),
    logPath,
    metaPath: join(dir, "meta.json"),
    driverPath: join(dir, "driver.json"),
    lockPath: `${logPath}.lock`,
  };
};

export const recordPaths = (rootDir: string, conversationId: string): RecordPaths =>
  pathsForDir(join(rootDir, conversationId));

export const validConversationId = (id: string): boolean =>
  id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(id) && id !== "." && id !== "..";
