import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleFreshness,
  ensureFreshBundle,
  killSurvivors,
  sweepStaleRoots,
  survivingProcesses,
} from "./e2e/gate.ts";

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), "lucid-gate-test-"));

/** mtimes are the whole subject here, so they are set rather than assumed:
 *  two files written back to back can land in the same millisecond. */
const setMtime = async (path: string, msSinceEpoch: number): Promise<void> => {
  const seconds = msSinceEpoch / 1000;
  await utimes(path, seconds, seconds);
};

describe("the build gate", () => {
  test("a bundle older than its sources is stale", async () => {
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const bundle = join(dir, "bundle.ts");
      await writeFile(bundle, "old");
      await writeFile(join(src, "app.tsx"), "new");
      await setMtime(bundle, 1_000_000);
      await setMtime(join(src, "app.tsx"), 2_000_000);

      const freshness = await bundleFreshness(bundle, [src]);
      expect(freshness.fresh).toBe(false);
      expect(freshness.newestSourcePath).toBe(join(src, "app.tsx"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bundle newer than its sources is fresh", async () => {
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const bundle = join(dir, "bundle.ts");
      await writeFile(join(src, "app.tsx"), "src");
      await writeFile(bundle, "built");
      await setMtime(join(src, "app.tsx"), 1_000_000);
      await setMtime(bundle, 2_000_000);

      expect((await bundleFreshness(bundle, [src])).fresh).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing bundle is stale, not an error", async () => {
    const dir = await scratch();
    try {
      const freshness = await bundleFreshness(join(dir, "nothing-here.ts"), [dir]);
      expect(freshness.fresh).toBe(false);
      expect(freshness.bundleMtimeMs).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a nested source file counts - staleness is not just the top level", async () => {
    const dir = await scratch();
    try {
      const deep = join(dir, "client", "chrome", "ui");
      await mkdir(deep, { recursive: true });
      const bundle = join(dir, "bundle.ts");
      await writeFile(bundle, "old");
      await writeFile(join(deep, "button.tsx"), "new");
      await setMtime(bundle, 1_000_000);
      await setMtime(join(deep, "button.tsx"), 2_000_000);

      const freshness = await bundleFreshness(bundle, [join(dir, "client")]);
      expect(freshness.fresh).toBe(false);
      expect(freshness.newestSourcePath).toBe(join(deep, "button.tsx"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stale bundle is rebuilt, and the run continues", async () => {
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const bundle = join(dir, "bundle.ts");
      await writeFile(bundle, "old");
      await writeFile(join(src, "app.tsx"), "new");
      await setMtime(bundle, 1_000_000);
      await setMtime(join(src, "app.tsx"), 2_000_000);

      let built = 0;
      await ensureFreshBundle({
        bundlePath: bundle,
        sourceDirs: [src],
        build: async () => {
          built += 1;
          await writeFile(bundle, "rebuilt");
          await setMtime(bundle, 3_000_000);
        },
      });
      expect(built).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a build that does not produce a newer bundle REFUSES the run", async () => {
    // The whole reason the gate exists. A build script can exit 0 and leave the
    // artifact untouched; without this second check the suite would run against
    // the old bundle and report a green result about code not in this commit.
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const bundle = join(dir, "bundle.ts");
      await writeFile(bundle, "old");
      await writeFile(join(src, "app.tsx"), "new");
      await setMtime(bundle, 1_000_000);
      await setMtime(join(src, "app.tsx"), 2_000_000);

      const promise = ensureFreshBundle({
        bundlePath: bundle,
        sourceDirs: [src],
        build: async () => {
          /* exits 0, changes nothing - the failure this gate is for */
        },
      });
      await expect(promise).rejects.toThrow(/still stale after building/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a source dated in the future is diagnosed as such, not as a build failure", async () => {
    // No build can ever catch up with it, so the generic "the build did nothing"
    // message would send someone hunting the wrong bug.
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const bundle = join(dir, "bundle.ts");
      await writeFile(bundle, "built");
      await writeFile(join(src, "app.tsx"), "from the future");
      await setMtime(join(src, "app.tsx"), Date.now() + 365 * 24 * 60 * 60 * 1000);

      const promise = ensureFreshBundle({
        bundlePath: bundle,
        sourceDirs: [src],
        build: async () => {
          await setMtime(bundle, Date.now());
        },
      });
      await expect(promise).rejects.toThrow(/dated in the future/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fresh bundle is not rebuilt", async () => {
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const bundle = join(dir, "bundle.ts");
      await writeFile(join(src, "app.tsx"), "src");
      await writeFile(bundle, "built");
      await setMtime(join(src, "app.tsx"), 1_000_000);
      await setMtime(bundle, 2_000_000);

      let built = 0;
      await ensureFreshBundle({
        bundlePath: bundle,
        sourceDirs: [src],
        build: async () => {
          built += 1;
        },
      });
      expect(built).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the run-root sweep", () => {
  test("removes roots older than the cutoff and leaves the rest", async () => {
    const dir = await scratch();
    try {
      const old = join(dir, "run-old");
      const recent = join(dir, "run-recent");
      await mkdir(old);
      await mkdir(recent);
      await writeFile(join(old, "log.ndjson"), "{}");
      const now = 10_000_000_000;
      await setMtime(old, now - 48 * 60 * 60 * 1000);
      await setMtime(recent, now - 60 * 1000);

      const removed = await sweepStaleRoots({
        root: dir,
        maxAgeMs: 24 * 60 * 60 * 1000,
        now,
      });
      expect(removed).toEqual([old]);
      // The one that stays has to actually still be there: a sweep that removed
      // everything would also satisfy an assertion about what it reported.
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(old)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a root directory that has never existed is not an error", async () => {
    const removed = await sweepStaleRoots({
      root: join(tmpdir(), "lucid-gate-test-nonexistent-root"),
      maxAgeMs: 1,
      now: Date.now(),
    });
    expect(removed).toEqual([]);
  });
});

describe("survivor detection", () => {
  const MAIN = "/Users/dev/lucid/src/cli/main.ts";

  test("claims a detached __serve holding a harness temp path", () => {
    const ps = `  4321 /usr/local/bin/bun ${MAIN} __serve /var/folders/x/lucid-e2e-abc123/plan.html`;
    expect(survivingProcesses(ps, MAIN)).toEqual([
      {
        pid: 4321,
        command: `/usr/local/bin/bun ${MAIN} __serve /var/folders/x/lucid-e2e-abc123/plan.html`,
      },
    ]);
  });

  test("claims a harness hub, which is the only thing asking for port 0", () => {
    const ps = `  555 bun run ${MAIN} hub --port 0 --attend`;
    expect(survivingProcesses(ps, MAIN).map((s) => s.pid)).toEqual([555]);
  });

  test("LEAVES the developer's own hub from this same checkout", () => {
    // The one that matters. A sweep matching every process running main.ts
    // would kill the session the developer is working in.
    const ps = [
      `  100 bun run ${MAIN} hub --port 17428`,
      `  101 bun run ${MAIN} open /Users/dev/work/plan.html`,
      `  102 /usr/local/bin/bun ${MAIN} __serve /Users/dev/work/plan.html`,
    ].join("\n");
    expect(survivingProcesses(ps, MAIN)).toEqual([]);
  });

  test("leaves unrelated processes, including other bun projects", () => {
    const ps = [
      "  200 bun run /Users/dev/other/src/cli/main.ts hub --port 0",
      "  201 node /Users/dev/lucid/node_modules/.bin/playwright test",
      "  202 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer",
    ].join("\n");
    expect(survivingProcesses(ps, MAIN)).toEqual([]);
  });

  test("never claims the process doing the sweeping", () => {
    const ps = `  ${process.pid} bun run ${MAIN} hub --port 0`;
    expect(survivingProcesses(ps, MAIN)).toEqual([]);
  });

  test("tolerates ps output it cannot parse", () => {
    expect(survivingProcesses("", MAIN)).toEqual([]);
    expect(survivingProcesses("\n  \nnot a process line\n", MAIN)).toEqual([]);
  });

  test("a run with no survivors kills nothing and says nothing", async () => {
    const said: string[] = [];
    const killed = await killSurvivors(
      "/nonexistent/path/that/no/process/is/running/main.ts",
      (m) => said.push(m),
    );
    expect(killed).toEqual([]);
    expect(said).toEqual([]);
  });
});
