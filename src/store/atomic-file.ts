import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function syncPath(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function atomicSidecar(path: string, value: unknown): void {
  const tmp = `${path}.${crypto.randomUUID()}.part`;
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    syncPath(tmp);
    renameSync(tmp, path);
    renamed = true;
    syncPath(dirname(path));
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
}
