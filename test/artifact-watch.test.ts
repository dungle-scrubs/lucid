import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { createArtifactWatch } from "../src/server/artifact-watch.ts";

/**
 * createArtifactWatch (plan 05, M3.2 / DF-1): the debounced fs.watch, the
 * stat-gated poll, and the coalescing commit queue behind one module.
 *
 * The behavior-preserving extraction is covered by the daemon/server suites
 * (the rename route awaits commitNow, version commits broadcast). These tests
 * pin the three invariants the module exists to make explicit and that a race
 * with real disk I/O cannot exercise reliably:
 *
 * - commit coalescing: signals during an in-flight commit queue exactly one
 *   rerun, never a dropped or doubled commit.
 * - teardown (D-011): stop() during an in-flight commit lets it complete; a
 *   stopped guard inside commitNow would silently lose a version.
 * - stat-gate: a quiet poll performs no commit.
 *
 * A controllable `commit` (the module's testability seam; production uses
 * commitWatchedChange) drives the timing.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fixture = async (): Promise<SessionPaths> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-watch-"));
  dirs.push(dir);
  const paths = sessionPaths(join(dir, "plan.html"));
  await mkdir(paths.runDir, { recursive: true });
  await mkdir(paths.artifactDir, { recursive: true });
  await writeFile(paths.artifactPath, "<!doctype html><html><body></body></html>");
  return paths;
};

describe("createArtifactWatch: commit coalescing", () => {
  test("signals during an in-flight commit coalesce into one rerun", async () => {
    const paths = await fixture();
    let calls = 0;
    let resolveFirst: ((value: { committed?: undefined }) => void) | undefined;
    // The first commit blocks (in-flight); every later one resolves at once.
    const commit = (): Promise<{ committed?: undefined }> => {
      calls += 1;
      if (calls === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return Promise.resolve({});
    };
    const watch = createArtifactWatch(paths, { commit });

    const first = watch.commitNow(); // in-flight (calls === 1)
    // Two more signals while the first is mid-flight: each must queue, not start
    // its own commit, and the two must collapse into a single rerun.
    void watch.commitNow();
    void watch.commitNow();
    expect(calls).toBe(1); // no extra commit started yet

    resolveFirst?.({}); // release the in-flight commit
    await first;
    // The do-while ran one rerun (calls === 2), not two - the second queued
    // signal did not double the rerun.
    expect(calls).toBe(2);
    watch.stop();
  });
});

describe("createArtifactWatch: teardown (D-011)", () => {
  test("stop() during an in-flight commit still completes it", async () => {
    const paths = await fixture();
    let completed = false;
    let resolveCommit: ((value: { committed?: undefined }) => void) | undefined;
    const commit = (): Promise<{ committed?: undefined }> =>
      new Promise((resolve) => {
        resolveCommit = (value) => {
          completed = true;
          resolve(value);
        };
      });
    const watch = createArtifactWatch(paths, { commit });

    const first = watch.commitNow(); // in-flight
    // Stop while the commit is mid-flight. A `stopped` guard inside commitNow
    // would abandon this commit and silently lose the version.
    watch.stop();
    resolveCommit?.({});
    await first;
    expect(completed).toBe(true);
  });
});

describe("createArtifactWatch: stat-gate", () => {
  test("a quiet poll performs no commit", async () => {
    const paths = await fixture();
    // Let the filesystem settle after the fixture write so the watcher does
    // not see the setup as a change.
    await new Promise((r) => setTimeout(r, 200));
    let calls = 0;
    const watch = createArtifactWatch(paths, {
      commit: async () => {
        calls += 1;
        return {};
      },
    });
    // Wait past TWO poll intervals (2s). The poll is gated on the stat
    // fingerprint: an unchanged file triggers no commit from the poll. A
    // single spurious fs.watch event is tolerable; what is NOT tolerable
    // (and what an unguarded poll would do) is one commit per tick.
    await new Promise((r) => setTimeout(r, 2200));
    expect(calls).toBeLessThanOrEqual(1);
    watch.stop();
  });
});
