import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * What has to be true before an e2e run means anything, and what has to be
 * cleaned up after it - as functions rather than as steps inside `globalSetup`,
 * so each one can be tested without a browser.
 *
 * That split is the point. A build gate whose only expression is four lines
 * inside a Playwright hook can be verified exactly once, by hand, by making the
 * bundle stale and watching. Every function here takes its inputs as arguments
 * and returns what it decided, so `test/e2e-gate.test.ts` can put a stale bundle
 * or an old run-root in front of it and assert on the answer.
 */

/**
 * Everything the client bundle is built FROM, repo-relative.
 *
 * `client/` is not a closed graph, which is the trap here. `client/shared/
 * capture.ts` imports `src/anchors/dom.ts`, and that anchor-resolution code is
 * compiled into the overlay bundle - the code `selection.e2e.ts` and the
 * multi-target suite spend most of their time driving. A gate watching only
 * `client/` would let you fix `resolveRangeAnchor`, run the suite against the
 * old resolver, and get a green result about code that is not in the commit:
 * exactly the failure this gate exists to prevent, on the best-covered path.
 *
 * Coarse on purpose - whole directories rather than the six files actually
 * imported - because a list of files goes stale the first time someone adds an
 * import. `test/e2e-gate.test.ts` asserts that every `../../src/…` import under
 * `client/` resolves inside one of these roots, so the coarseness cannot drift
 * into a hole in silence.
 *
 * The cost is a rebuild when `src/core` changes without affecting the bundle.
 * A rebuild is seconds; a gate that reports fresh when it is not has no value
 * at all.
 */
export const BUNDLE_SOURCES = [
  "client",
  // Reached from client/ by value imports - see the drift test.
  "src/anchors",
  "src/core",
  "src/protocol",
  // Embedded as FAVICON_SVG by the build script.
  "assets/lucid-mark.svg",
  // The build itself: a change to HOW the bundle is made stales it as surely as
  // a change to what goes in it.
  "scripts/build-client.ts",
] as const;

/**
 * Everything the COMPILED binary is built from, repo-relative.
 *
 * `dist/lucid` is `bun build --compile` over `src/cli/main.ts`, so its inputs
 * are the whole of `src/` - which includes `src/server/client-bundle.
 * generated.ts`, the browser bundle it embeds - plus the compile script itself.
 * `BUNDLE_SOURCES` rides along because a change under `client/` reaches the
 * binary THROUGH that generated file, and the two builds run in the same hook:
 * a source that stales the bundle stales the binary a moment later.
 *
 * Coarse for the same reason `BUNDLE_SOURCES` is: a list of imported files goes
 * stale the first time somebody adds an import, and a gate that reports fresh
 * when it is not has no value at all. The cost is a recompile when a file the
 * binary does not use changes; the alternative is a green run about a binary
 * from a previous commit, which is exactly what `compiled-binary-selfinvocation`
 * exists to rule out - `selfInvocation` lives in `src/cli/self.ts`, which the
 * old bundle-only check could not see.
 */
export const BINARY_SOURCES = [...BUNDLE_SOURCES, "src", "scripts/build-binary.ts"] as const;

/**
 * The newest mtime among `sources`, and which file it belongs to.
 *
 * Each entry may be a directory (walked recursively) or a single file - the
 * build script is as much an input as the code it compiles, and it does not
 * live under `client/`. Treating a file as an unreadable directory and skipping
 * it would leave the gate quietly blind to exactly that case.
 */
export const newestSource = async (
  sources: readonly string[],
): Promise<{ readonly path: string; readonly mtimeMs: number } | undefined> => {
  let newest: { path: string; mtimeMs: number } | undefined;
  const consider = (path: string, mtimeMs: number): void => {
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  };

  for (const source of sources) {
    let entries: Dirent[];
    try {
      entries = await readdir(source, { withFileTypes: true, recursive: true });
    } catch {
      // Either a single file, or nothing at all. A file counts; a path that
      // does not exist cannot stale anything.
      try {
        consider(source, (await stat(source)).mtimeMs);
      } catch {
        /* not there */
      }
      continue;
    }
    // The root itself, then everything under it. Directories count as much as
    // files: creating or deleting a file bumps its parent's mtime and nothing
    // else, so a delete would otherwise leave the bundle stale while the gate
    // called it current - and the root is where a top-level add or delete
    // registers, which nothing below would see.
    consider(source, (await stat(source)).mtimeMs);
    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name);
      consider(path, (await stat(path)).mtimeMs);
    }
  }
  return newest;
};

export interface Freshness {
  readonly fresh: boolean;
  /** Absent when the bundle does not exist at all. */
  readonly bundleMtimeMs?: number;
  readonly newestSourcePath?: string;
  readonly newestSourceMtimeMs?: number;
}

/** Is the built bundle at least as new as every file it is built from? */
export const bundleFreshness = async (
  bundlePath: string,
  sources: readonly string[],
): Promise<Freshness> => {
  const newest = await newestSource(sources);
  let bundleMtimeMs: number | undefined;
  try {
    bundleMtimeMs = (await stat(bundlePath)).mtimeMs;
  } catch {
    return { fresh: false, newestSourcePath: newest?.path, newestSourceMtimeMs: newest?.mtimeMs };
  }
  if (!newest) return { fresh: true, bundleMtimeMs };
  return {
    fresh: bundleMtimeMs >= newest.mtimeMs,
    bundleMtimeMs,
    newestSourcePath: newest.path,
    newestSourceMtimeMs: newest.mtimeMs,
  };
};

export interface BuildGate {
  readonly bundlePath: string;
  /** Directories to walk, or single files. Both are real inputs. */
  readonly sources: readonly string[];
  /** Injected so a test can supply one that does nothing and watch the gate
   *  refuse, which is the only way to observe the refusal without a real
   *  stale checkout. */
  readonly build: () => Promise<void>;
  /** Where to narrate what happened. */
  readonly log?: (message: string) => void;
}

/**
 * Ensure the bundle is newer than its sources, building it if it is not, and
 * REFUSE the run if it still is not afterwards.
 *
 * `src/server/client-bundle.generated.ts` is gitignored, so it is whatever the
 * last build left behind. The suite drives the shell that bundle *is*, so a
 * green run against a stale one is a green run about code that is not in the
 * commit - which is indistinguishable, from the outside, from a green run about
 * code that is. Building is the fix; the second check is what turns "the build
 * script exited 0" into "the artifact on disk is actually newer", which are not
 * the same claim and have not always agreed.
 */
export const ensureFreshBundle = async (gate: BuildGate): Promise<Freshness> => {
  const log = gate.log ?? (() => {});
  const before = await bundleFreshness(gate.bundlePath, gate.sources);
  if (before.fresh) {
    log(`bundle is current (${gate.bundlePath})`);
    return before;
  }
  log(
    before.bundleMtimeMs === undefined
      ? `no bundle at ${gate.bundlePath} - building`
      : `bundle is older than ${before.newestSourcePath} - rebuilding`,
  );
  await gate.build();

  const after = await bundleFreshness(gate.bundlePath, gate.sources);
  if (!after.fresh) {
    // A source dated in the future can never be caught up with, however well
    // the build works, so it gets its own diagnosis - the generic message would
    // send someone hunting a build bug over a bad clock or a restored mtime.
    const fromTheFuture =
      after.newestSourceMtimeMs !== undefined && after.newestSourceMtimeMs > Date.now();
    throw new Error(
      [
        fromTheFuture
          ? "refusing to run: a source file is dated in the future, so no build can ever look current."
          : "refusing to run: the client bundle is still stale after building it.",
        `  bundle: ${gate.bundlePath}`,
        `    mtime ${after.bundleMtimeMs === undefined ? "(missing)" : new Date(after.bundleMtimeMs).toISOString()}`,
        `  newest source: ${after.newestSourcePath}`,
        `    mtime ${after.newestSourceMtimeMs === undefined ? "(none)" : new Date(after.newestSourceMtimeMs).toISOString()}`,
        fromTheFuture
          ? "Fix the file's timestamp (`touch` it) or the clock that produced it."
          : [
              "The build reported success without producing a newer artifact, so every",
              "assertion this run makes about the shell would be about code that is not",
              "in this commit.",
            ].join("\n"),
      ].join("\n"),
    );
  }
  return after;
};

/**
 * Remove run roots left behind by earlier runs.
 *
 * The durable-path fixture (M5.5) puts each run under `~/.lucid-e2e/<run-id>/`,
 * deliberately outside `defaultRoots()` and outside the temp dir, because some
 * scenarios need a path that survives a reboot. Nothing survives a `SIGKILL`
 * test to clean up after itself, so they accumulate; anything older than
 * `maxAgeMs` cannot belong to a run still in progress.
 */
export const sweepStaleRoots = async (opts: {
  readonly root: string;
  readonly maxAgeMs: number;
  readonly now: number;
}): Promise<readonly string[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(opts.root, { withFileTypes: true });
  } catch {
    return []; // nothing has ever written one
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const path = join(opts.root, entry.name);
    try {
      const { mtimeMs } = await stat(path);
      if (opts.now - mtimeMs < opts.maxAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // vanished under us, or not ours to remove; either way not this run's problem
    }
  }
  return removed;
};

export interface Survivor {
  readonly pid: number;
  readonly command: string;
}

/**
 * Processes from `ps` output that this suite started and failed to stop.
 *
 * Pure, and deliberately narrow. The developer runs Lucid from this same
 * checkout, so "anything running `src/cli/main.ts`" would match their own hub
 * and kill it - a test suite that reaps the user's editor session is worse than
 * one that leaks. Every match therefore needs a second signature that only the
 * harness produces:
 *
 * - a path under the harness's temp dirs (`lucid-e2e-*`, `lucid-hub-e2e-*`),
 *   which covers detached `__serve` children and long-running `wait` calls; or
 * - `hub --port 0`, which is how `startHub` asks for an ephemeral port and is
 *   not something a human types.
 *
 * Anything the harness starts that carries neither is out of reach here, and
 * belongs to fixture teardown (M3.1) rather than to a process sweep.
 */
export const survivingProcesses = (psOutput: string, repoMain: string): readonly Survivor[] => {
  const survivors: Survivor[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (pid === process.pid || !Number.isFinite(pid)) continue;
    if (!command.includes(repoMain)) continue;
    const harnessOwned =
      /lucid-(?:hub-)?e2e-/.test(command) || /\bhub\s+--port\s+0(?:\s|$)/.test(command);
    if (harnessOwned) survivors.push({ pid, command });
  }
  return survivors;
};

/**
 * Kill what the suite left running, and say what was killed.
 *
 * Reported rather than reaped in silence: a survivor is a bug in whichever
 * fixture should have stopped it, and a teardown that quietly tidies up is a
 * teardown that hides the leak it exists to reveal.
 */
export const killSurvivors = async (
  repoMain: string,
  log: (message: string) => void = console.warn,
): Promise<readonly Survivor[]> => {
  let psOutput = "";
  try {
    // -ww: never truncate. procps sizes piped output to a buffer default but
    // lets an exported COLUMNS override it afterwards, and the marker this
    // matcher needs sits at the END of the line - precisely what truncation
    // eats. One flag removes the whole class of silent miss.
    const { stdout } = await execFileAsync("ps", ["-wwAo", "pid=,command="]);
    psOutput = stdout;
  } catch (error) {
    // Never silently: a sweep that cannot list processes reports exactly what a
    // clean run reports, so every run afterwards would look healthy while
    // reaping nothing. That is the failure this whole function is written to
    // avoid, one level up.
    log(`could not list processes, so nothing was reaped: ${(error as Error).message}`);
    return [];
  }
  const survivors = survivingProcesses(psOutput, repoMain);
  if (survivors.length === 0) return [];
  log(
    `${survivors.length} process${survivors.length === 1 ? "" : "es"} outlived the suite - killing:`,
  );
  for (const survivor of survivors) {
    log(`  ${survivor.pid}  ${survivor.command}`);
    try {
      process.kill(survivor.pid, "SIGKILL");
    } catch {
      // already gone between the listing and the signal
    }
  }
  return survivors;
};
