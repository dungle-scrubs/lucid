/**
 * The blob store: an attachment's bytes, beside the log, inside the record
 * (RFC-11).
 *
 * ```
 * <record>/files/<sha256-hex>
 * ```
 *
 * **Inside the record**, because the record is the unit that travels.
 * `CONTEXT.md` leads with reopening a record and handing it to a different
 * agent; an attachment the transcript refers to has to move with it, or
 * copying a record leaves a reference to a file that is not there. The record
 * already holds bytes that are not the log - `secret` - so this is not a new
 * idea, only a larger one.
 *
 * **Beside the log rather than in it**, because of memory. Folding a 67 MB
 * log costs 19 ms and 335 MB of resident memory, five times the file, because
 * a fold holds what it reads. Time was never the problem.
 *
 * **Addressed by content**, so the same file attached twice is stored once,
 * the log's copy of the hash can verify the bytes, and a name cannot be
 * reused to mean different bytes - which is what an append-only record needs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withinAttachmentBound } from "../protocol/attachment.js";
import { StoreError } from "./errors.js";

/** The directory inside a record holding blobs. */
export const BLOB_DIR = "files";

/** sha256 hex of raw bytes.
 *
 * The same hash `hashArtifactBytes` computes, over bytes rather than a
 * string. A second hash for a second purpose would be two answers to one
 * question. */
export const hashBlob = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isHashHex = (v: string): boolean => /^[0-9a-f]{64}$/.test(v);

/** Where a blob lives.
 *
 * The name is checked as a hash, never used as a path. A caller that passes
 * something else gets a refusal rather than a traversal: `..` and `secret`
 * are not 64 hex characters, and the check happens before anything touches
 * the filesystem. */
export const blobPath = (recordDir: string, hash: string): string => {
  if (!isHashHex(hash))
    throw new StoreError("corrupt-log", `not a blob name: ${hash.slice(0, 32)}`);
  return join(recordDir, BLOB_DIR, hash);
};

/**
 * Store bytes and return their hash.
 *
 * Refuses before writing anything when the file is over the bound - a file
 * that is going to be refused must not be copied first.
 *
 * Writing is atomic: the bytes go to a temporary name in the same directory
 * and are renamed into place. A reader therefore sees a blob or no blob,
 * never half of one, and the log entry that names it can be appended after
 * with the guarantee it needs.
 *
 * Already-stored bytes are not written again. That is the deduplication
 * content addressing buys, and it makes storing idempotent.
 */
export const putBlob = (recordDir: string, bytes: Uint8Array): string => {
  if (!withinAttachmentBound(bytes.byteLength)) {
    throw new StoreError(
      "corrupt-log",
      `attachment-too-large: ${bytes.byteLength} bytes; nothing was written`,
    );
  }
  const hash = hashBlob(bytes);
  const dir = join(recordDir, BLOB_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const final = join(dir, hash);
  if (existsSync(final)) return hash;
  // Same directory, so the rename is on one filesystem and is atomic.
  const tmp = `${final}.${process.pid}.part`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, final);
  return hash;
};

/** Read a blob back, or null when it is not there.
 *
 * Null rather than throwing: a record can be copied without its blobs by
 * someone using the wrong tool, and the honest response is to say the file is
 * gone rather than to refuse to open the conversation. */
export const getBlob = (recordDir: string, hash: string): Uint8Array | null => {
  const p = blobPath(recordDir, hash);
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
};

/** Whether a blob is present, without reading it. */
export const hasBlob = (recordDir: string, hash: string): boolean =>
  existsSync(blobPath(recordDir, hash));

/** A blob's size, or null when it is not there. */
export const blobSize = (recordDir: string, hash: string): number | null => {
  const p = blobPath(recordDir, hash);
  if (!existsSync(p)) return null;
  return statSync(p).size;
};
