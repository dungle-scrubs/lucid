import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  let created = false;
  let renamed = false;
  try {
    const fd = openSync(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    renamed = true;
    syncPath(dirname(path));
  } finally {
    if (created && !renamed) {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
}
