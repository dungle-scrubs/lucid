import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The ONE atomic JSON publish: write a uniquely named sibling, then rename
 * over the target. A reader sees the old complete document or the new
 * complete document, never a torn one - and the unique name means two
 * processes racing the same target cannot write through each other's tmp
 * file. This existed as four private copies (registry, attendant sidecar,
 * session snapshot, launcher ledger), each with its own tmp-naming scheme;
 * drift between them was real before it was hypothetical.
 */
export const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
};
