import { readFileSync } from "node:fs";
import { pathsForDir, type RecordPaths, StoreError, validConversationId } from "./errors.js";
import { Flock, type LockEvent } from "./flock.js";

export interface RecordMetadata extends Record<string, unknown> {
  readonly v: 1;
  readonly conversationId: string;
}

export const decodeRecordMetadata = (text: string): RecordMetadata => {
  try {
    const meta: unknown = JSON.parse(text);
    if (
      meta &&
      typeof meta === "object" &&
      "v" in meta &&
      meta.v === 1 &&
      "conversationId" in meta &&
      typeof meta.conversationId === "string" &&
      validConversationId(meta.conversationId)
    )
      return meta as RecordMetadata;
  } catch {
    /* A missing or invalid identity never falls back to the directory name. */
  }
  throw new StoreError("corrupt-log", "Record identity is unavailable");
};

export const readRecordMetadata = (dir: string): RecordMetadata => {
  try {
    return decodeRecordMetadata(readFileSync(pathsForDir(dir).metaPath, "utf8"));
  } catch {
    throw new StoreError("corrupt-log", "Record identity is unavailable");
  }
};

export const withRecordLock = <T>(
  paths: RecordPaths,
  conversationId: string,
  action: () => T,
  onLockEvent?: (event: LockEvent) => void,
): T => {
  const lock = new Flock(paths.lockPath, conversationId).acquire({ onEvent: onLockEvent });
  try {
    if (readRecordIdentity(paths.dir) !== conversationId)
      throw new StoreError("corrupt-log", "Record identity changed");
    return action();
  } finally {
    lock.release();
  }
};

export const readRecordIdentity = (dir: string): string => readRecordMetadata(dir).conversationId;
