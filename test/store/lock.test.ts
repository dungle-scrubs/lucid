import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAppendLock,
  acquireWith,
  LockError,
  type LockEvent,
} from "../../src/store/flock.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "lucid-lock-"));

/**
 * M1.1 - the flock append-lock primitive. `flock(2)` is the single mandated
 * backend (D-008): the kernel releases it when the holding fd closes or the
 * process dies, which no userspace lockfile can guarantee. When flock is
 * unavailable there is NO safe write lock - the backend reports "readonly"
 * and acquire refuses, rather than falling back to an O_EXCL lockfile that
 * cannot release on death and does not interoperate with flock.
 */
describe("append-lock acquire / hold / release (M1.1)", () => {
  test("release permits the same target to be acquired again", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    try {
      const lock = acquireAppendLock(target, { timeoutMs: 1_000 });
      lock.release();
      acquireAppendLock(target, { timeoutMs: 0 }).release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second acquire on a held target WAITS, then times out with LockError lock-timeout (E001); release lets a later acquire succeed", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    try {
      const first = acquireAppendLock(target, { timeoutMs: 1_000 });
      const start = Date.now();
      let err: unknown;
      try {
        acquireAppendLock(target, { timeoutMs: 150 });
      } catch (e) {
        err = e;
      }
      const waited = Date.now() - start;
      expect(err).toBeInstanceOf(LockError);
      expect((err as LockError).code).toBe("lock-timeout");
      expect((err as LockError).target).toBe(target);
      // It waited out the timeout retrying - not an instant single-shot refusal,
      // and it did NOT overshoot into a multi-second hang.
      expect(waited).toBeGreaterThanOrEqual(120);
      expect(waited).toBeLessThan(2_000);
      // The first holder is untouched; releasing it frees the target.
      first.release();
      const third = acquireAppendLock(target, { timeoutMs: 1_000 });
      third.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("append-lock unavailable backend refuses, never falls back (M1.1, D-008)", () => {
  test("acquireWith(undefined, ...) throws LockError lock-unavailable and creates no fallback lockfile", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    try {
      let err: unknown;
      try {
        acquireWith(undefined, target, { timeoutMs: 100 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LockError);
      expect((err as LockError).code).toBe("lock-unavailable");
      expect((err as LockError).target).toBe(target);
      // Critically: it bailed BEFORE opening any lockfile - no O_EXCL mutex.
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("append-lock structured events (M1.1 observability)", () => {
  test("emits lock.acquire/lock.release with the label, and lock.timeout with waitedMs under contention", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    const events: LockEvent[] = [];
    const onEvent = (e: LockEvent): void => {
      events.push(e);
    };
    try {
      const first = acquireAppendLock(target, { timeoutMs: 1_000, label: "conv-1", onEvent });
      expect(events.at(-1)).toEqual({ event: "lock.acquire", target, label: "conv-1" });

      let err: unknown;
      try {
        acquireAppendLock(target, { timeoutMs: 130, label: "conv-1", onEvent });
      } catch (e) {
        err = e;
      }
      expect((err as LockError).code).toBe("lock-timeout");
      const timeout = events.find((e) => e.event === "lock.timeout");
      expect(timeout).toBeDefined();
      if (timeout?.event === "lock.timeout") {
        expect(timeout.label).toBe("conv-1");
        expect(timeout.target).toBe(target);
        expect(timeout.waitedMs).toBeGreaterThanOrEqual(100);
      }

      first.release();
      expect(events.at(-1)).toEqual({ event: "lock.release", target, label: "conv-1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("append-lock cross-process death-release (M1.1, D-008)", () => {
  test("a lock held by another process blocks acquire; killing that process kernel-releases it", async () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    // Use this process's own Bun binary, not a bare "bun" on PATH.
    const child = spawn(process.execPath, [join(import.meta.dir, "lock-hold-child.ts"), target], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      // Wait until the child confirms it holds the lock.
      await new Promise<void>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("child never acquired the lock")), 8_000);
        child.stdout?.on("data", (d: Buffer) => {
          buf += d.toString();
          if (buf.includes("ACQUIRED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", () => {
          clearTimeout(timer);
          reject(new Error("child exited before acquiring"));
        });
      });

      // While the child holds it, this process cannot acquire (cross-process mutex).
      let err: unknown;
      try {
        acquireAppendLock(target, { timeoutMs: 200 });
      } catch (e) {
        err = e;
      }
      expect((err as LockError).code).toBe("lock-timeout");

      // Kill the holder WITHOUT an explicit release; the kernel must free the flock.
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));

      const lock = acquireAppendLock(target, { timeoutMs: 3_000 });
      lock.release();
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("append-lock lifecycle robustness (M1.1 boundary-review fixes)", () => {
  test("release() is idempotent - a second release does not throw", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    try {
      const lock = acquireAppendLock(target, { timeoutMs: 1_000 });
      lock.release();
      expect(() => lock.release()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-finite or negative timeout is rejected (never an infinite hang) and opens no lockfile", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        expect(() => acquireAppendLock(target, { timeoutMs: bad })).toThrow(RangeError);
      }
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing onEvent sink never strands the lock - acquire still returns a working handle", () => {
    const dir = scratch();
    const target = join(dir, "log.ndjson");
    const boom = (): never => {
      throw new Error("sink blew up");
    };
    try {
      // A throwing sink must not corrupt lock lifecycle: acquire succeeds,
      // the lock is held, and release still frees it.
      const lock = acquireAppendLock(target, { timeoutMs: 1_000, onEvent: boom });
      expect(() => lock.release()).not.toThrow();
      // The target is genuinely free afterwards.
      const again = acquireAppendLock(target, { timeoutMs: 1_000 });
      again.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
