import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "../config/user-config.js";
import { DiscoveryIndex } from "./discovery.js";
import { type AppendLock, acquireAppendLock, LockError } from "./flock.js";
import { WorkingFolderError } from "./project-directory.js";
import { createConversationRecord } from "./store.js";

export class CreationError extends Error {
  get code() {
    return this.status === 503 ? "E-HUB-01" : "E-HUB-02";
  }
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export interface CreationRequest {
  readonly settings?: Partial<Settings>;
  readonly workingDirectory: string;
}
/** One root lock serializes cold receipt lookup and atomic publication across processes. */
export async function createWithReceipt(
  root: string,
  id: string,
  request: CreationRequest,
  resolve: () => Promise<Settings>,
  receiptIndex = new DiscoveryIndex(root),
): Promise<{ conversationId: string }> {
  try {
    await mkdir(root, { recursive: true });
  } catch {
    throw new CreationError(
      "Record folder is unavailable. Check its location and permissions, then retry the same request.",
      503,
    );
  }
  const deadline = performance.now() + 2000;
  let lock: AppendLock;
  for (;;) {
    try {
      lock = acquireAppendLock(join(root, ".creation"), { timeoutMs: 0 });
      break;
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== "lock-timeout")
        throw new CreationError(
          "Cannot lock the record folder. Check access and retry the same request.",
          503,
        );
      if (performance.now() >= deadline)
        throw new CreationError("Creation is busy. Retry the same request.", 503);
      await Bun.sleep(10);
    }
  }
  try {
    let matches: Awaited<ReturnType<DiscoveryIndex["receipts"]>>;
    try {
      matches = await receiptIndex.receipts(id);
    } catch {
      throw new CreationError(
        "Cannot verify all creation receipts. Repair unreadable metadata before creating.",
        503,
      );
    }
    if (matches.length > 1)
      throw new CreationError("Duplicate creation receipts. Repair the conflicting records.");
    const found = matches[0];
    if (found) {
      if (JSON.stringify(found.request) !== JSON.stringify(request))
        throw new CreationError(
          "This creation ID was used with different choices. Use a new creation ID.",
        );
      return { conversationId: found.conversationId };
    }
    const preference = await resolve();
    const conversationId = crypto.randomUUID();
    try {
      createConversationRecord(root, conversationId, {
        workingDirectory: request.workingDirectory,
        creation: { id, request },
        preference: { v: 1, revision: 1, ...preference },
      });
    } catch (error) {
      if (error instanceof WorkingFolderError) throw error;
      throw new CreationError(
        "Creation was not confirmed. Check the record folder and retry the same request.",
        503,
      );
    }
    return { conversationId };
  } finally {
    lock.release();
  }
}
