/**
 * Test helper for M1.1's cross-process check: acquire the append lock on the
 * path in argv[2], announce it on stdout, then hold it until the parent kills
 * this process - proving the kernel releases the flock on holder death, not on
 * an explicit release.
 */
import { acquireAppendLock } from "../../src/store/flock.js";

const target = process.argv[2];
if (target === undefined) {
  process.stderr.write("usage: lock-hold-child <lockTargetPath>\n");
  process.exit(2);
}

acquireAppendLock(target, { timeoutMs: 5_000 });
process.stdout.write("ACQUIRED\n");
// Hold the lock open; only a kill (or the harness timeout) ends this process.
setInterval(() => {}, 1_000);
