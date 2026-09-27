import {
  closeSync,
  constants,
  fchmodSync,
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
export function atomicSidecar(path: string, value: unknown, mode: number = 0o600): void {
  const tmp = `${path}.${crypto.randomUUID()}.part`;
  let created = false;
  let renamed = false;
  try {
    const fd = openSync(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode,
    );
    created = true;
    try {
      // Set the mode on the temporary file before the rename: a completed rename
      // then always leaves the destination with its intended mode.
      fchmodSync(fd, mode);
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
