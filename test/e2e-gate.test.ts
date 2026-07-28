import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BINARY_SOURCES,
  BUNDLE_SOURCES,
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
      await setMtime(src, 1_000_000);

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
      await setMtime(src, 1_000_000);
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
      for (const d of [deep, join(dir, "client", "chrome"), join(dir, "client")]) {
        await setMtime(d, 1_000_000);
      }

      const freshness = await bundleFreshness(bundle, [join(dir, "client")]);
      expect(freshness.fresh).toBe(false);
      expect(freshness.newestSourcePath).toBe(join(deep, "button.tsx"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("DELETING a source stales the bundle, which only a directory mtime shows", async () => {
    // A delete leaves no file behind to carry a new mtime - it bumps the
    // parent directory and nothing else. Watching files alone would call the
    // bundle current after a component was removed from the build.
    const dir = await scratch();
    try {
      const src = join(dir, "client");
      await mkdir(src);
      const doomed = join(src, "gone.tsx");
      const bundle = join(dir, "bundle.ts");
      await writeFile(doomed, "about to go");
      await writeFile(bundle, "built");
      await setMtime(doomed, 1_000_000);
      await setMtime(src, 1_000_000);
      await setMtime(bundle, 2_000_000);
      expect((await bundleFreshness(bundle, [src])).fresh).toBe(true);

      await rm(doomed);
      await setMtime(src, 3_000_000); // what the filesystem does on a delete

      const after = await bundleFreshness(bundle, [src]);
      expect(after.fresh).toBe(false);
      expect(after.newestSourcePath).toBe(src);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a single FILE listed as a source counts, not just directories", async () => {
    // The build script is an input and does not live under client/. Passing it
    // used to make readdir throw ENOTDIR, which the walk swallowed - so the one
    // source the gate claimed to cover beyond client/ was silently ignored.
    const dir = await scratch();
    try {
      const bundle = join(dir, "bundle.ts");
      const script = join(dir, "build-client.ts");
      await writeFile(bundle, "built");
      await writeFile(script, "the build itself changed");
      await setMtime(bundle, 1_000_000);
      await setMtime(script, 2_000_000);

      const freshness = await bundleFreshness(bundle, [script]);
      expect(freshness.fresh).toBe(false);
      expect(freshness.newestSourcePath).toBe(script);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a source path that does not exist is ignored, not fatal", async () => {
    const dir = await scratch();
    try {
      const bundle = join(dir, "bundle.ts");
      await writeFile(bundle, "built");
      const freshness = await bundleFreshness(bundle, [join(dir, "no-such-place")]);
      expect(freshness.fresh).toBe(true);
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
      await setMtime(src, 1_000_000);

      let built = 0;
      await ensureFreshBundle({
        bundlePath: bundle,
        sources: [src],
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
      await setMtime(src, 1_000_000);

      const promise = ensureFreshBundle({
        bundlePath: bundle,
        sources: [src],
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
      await setMtime(src, 1_000_000);

      const promise = ensureFreshBundle({
        bundlePath: bundle,
        sources: [src],
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
      await setMtime(src, 1_000_000);
      await setMtime(bundle, 2_000_000);

      let built = 0;
      await ensureFreshBundle({
        bundlePath: bundle,
        sources: [src],
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

describe("the declared bundle sources", () => {
  test("cover every src/ module that client/ actually imports", async () => {
    // BUNDLE_SOURCES is deliberately coarse - whole directories - so that adding
    // an import does not silently open a hole. This is what makes the coarseness
    // safe: `client/` is NOT a closed graph (client/shared/capture.ts pulls in
    // src/anchors/dom.ts, which is compiled into the overlay bundle the
    // selection suites drive), and a reach into a root nobody listed would let
    // the gate report fresh while the browser ran last week's code.
    const repo = join(import.meta.dirname, "..");
    const clientDir = join(repo, "client");
    const files = (await readdir(clientDir, { withFileTypes: true, recursive: true })).filter(
      (e) => e.isFile() && /\.tsx?$/.test(e.name),
    );

    const roots = BUNDLE_SOURCES.map((s) => join(repo, ...s.split("/")));
    const uncovered: string[] = [];
    for (const file of files) {
      const path = join(file.parentPath, file.name);
      const text = await readFile(path, "utf8");
      for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = match[1];
        if (!spec?.startsWith(".")) continue;
        const resolved = resolve(file.parentPath, spec);
        if (resolved.startsWith(clientDir)) continue;
        if (roots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) continue;
        uncovered.push(`${path.slice(repo.length + 1)} -> ${spec}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  test("names roots that exist - a typo would silently cover nothing", async () => {
    const repo = join(import.meta.dirname, "..");
    for (const source of BUNDLE_SOURCES) {
      expect(existsSync(join(repo, ...source.split("/")))).toBe(true);
    }
  });
});

describe("the declared binary sources", () => {
  test("carry everything the compile embeds: the bundle's inputs, src, the build script, and the dependency graph", () => {
    // `bun build --compile` embeds node_modules, so a `bun install` that
    // changes a package changes the binary - and the lockfile is the input
    // that records it. BINARY_SOURCES was first added without package.json or
    // bun.lock (M6.2 review, F6), so an install left dist/lucid-e2e reported
    // "current" while its embedded dependencies were last week's. This pins
    // the members, not the mtime logic - bundleFreshness is tested above.
    for (const required of [
      ...BUNDLE_SOURCES,
      "src",
      "scripts/build-binary.ts",
      "package.json",
      "bun.lock",
    ]) {
      expect([...BINARY_SOURCES] as string[]).toContain(required);
    }
  });

  test("names roots that exist", () => {
    const repo = join(import.meta.dirname, "..");
    for (const source of BINARY_SOURCES) {
      expect(existsSync(join(repo, ...source.split("/")))).toBe(true);
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
