import { mkdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The ONE atomic publish: write a uniquely named sibling, then rename over
 * the target. A reader sees the old complete document or the new complete
 * document, never a torn one - and the unique name means two processes (or
 * two concurrent writes in one process) racing the same target cannot write
 * through each other's tmp file. This existed as four private copies
 * (registry, attendant sidecar, session snapshot, launcher ledger), each with
 * its own tmp-naming scheme; drift between them was real before it was
 * hypothetical.
 */

/** A collision-free tmp sibling: pid + nanosecond time + uuid is unique across
 *  processes and across concurrent writers in one process. Same dir as the
 *  target so the rename stays on one filesystem (atomic on POSIX). */
const atomicTmp = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);

const publish = async (tmp: string, target: string): Promise<void> => {
  await rename(tmp, target);
};

const ensureDir = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
};

export const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  await ensureDir(path);
  const tmp = atomicTmp(path);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await publish(tmp, path);
};

/** Atomic publish of arbitrary text (M1.2). Same tmp-then-rename contract as
 *  `writeJsonFile`, for callers that format their own bytes (HTML, logs) or
 *  stringify JSON themselves. */
export const writeTextAtomic = async (path: string, content: string): Promise<void> => {
  await ensureDir(path);
  const tmp = atomicTmp(path);
  await writeFile(tmp, content);
  await publish(tmp, path);
};

/** Synchronous atomic publish (M1.2). Replaces the per-session `atomicWrite`
 *  copy that used a pid-only tmp; this shares the same collision-free naming as
 *  the async variants. Used where the served copy is rebuilt inline (current.html). */
export const writeTextAtomicSync = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = atomicTmp(path);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};
