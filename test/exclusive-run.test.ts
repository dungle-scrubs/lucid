import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimExclusiveRun, releaseExclusiveRun } from "../test/e2e/gate.ts";

/**
 * One e2e run at a time, enforced (found by causing it).
 *
 * Every Playwright run's globalTeardown calls `killSurvivors`, which SIGKILLs
 * every process matching the repo's CLI - including the servers a CONCURRENT
 * run is mid-test on. Running a filtered spec beside the full gate therefore
 * corrupts the gate: a server vanishes under a test and it fails on a timeout
 * that looks exactly like a flake. Two gate runs were reported red that way,
 * each naming a different innocent test.
 *
 * A rule nobody can follow reliably is a rule the code should hold, so the
 * claim is a lockfile and the second run refuses to start.
 */

describe("claimExclusiveRun", () => {
  const withDir = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-lock-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("the first run claims it", () => {
    withDir((dir) => {
      expect(claimExclusiveRun(join(dir, "run.lock"))).toEqual({ ok: true });
    });
  });

  test("a run held by ANOTHER live process is refused, and named", () => {
    withDir((dir) => {
      const lock = join(dir, "run.lock");
      // pid 1 is launchd: always alive, never us. A second claim from the SAME
      // process is deliberately allowed (idempotent re-entry), so the refusal
      // can only be tested with a foreign holder.
      writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() }));
      const second = claimExclusiveRun(lock);
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("unreachable");
      expect(second.reason).toContain("pid 1");
      // And says WHY it matters - the teardown's blast radius is the point.
      expect(second.reason).toMatch(/kill|teardown/i);
    });
  });

  test("re-claiming from the same process is allowed - one run, not one call", () => {
    withDir((dir) => {
      const lock = join(dir, "run.lock");
      expect(claimExclusiveRun(lock)).toEqual({ ok: true });
      expect(claimExclusiveRun(lock)).toEqual({ ok: true });
    });
  });

  test("releasing lets the next run in", () => {
    withDir((dir) => {
      const lock = join(dir, "run.lock");
      claimExclusiveRun(lock);
      releaseExclusiveRun(lock);
      expect(claimExclusiveRun(lock)).toEqual({ ok: true });
    });
  });

  test("a lock from a DEAD process is taken over, not a permanent wedge", () => {
    withDir((dir) => {
      const lock = join(dir, "run.lock");
      // A pid that cannot exist: the run crashed without releasing. A stale
      // lock that never clears would make the guard worse than the bug.
      writeFileSync(lock, JSON.stringify({ pid: 2_147_483_646, at: 1 }));
      expect(claimExclusiveRun(lock)).toEqual({ ok: true });
    });
  });

  test("an unparseable lock is taken over too", () => {
    withDir((dir) => {
      const lock = join(dir, "run.lock");
      writeFileSync(lock, "not json");
      expect(claimExclusiveRun(lock)).toEqual({ ok: true });
    });
  });
});
