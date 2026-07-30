import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BINARY_SOURCES,
  claimExclusiveRun,
  BUNDLE_SOURCES,
  bundleFreshness,
  ensureFreshBundle,
  sweepStaleRoots,
} from "./gate.ts";
import { BINARY } from "./cli.ts";

const execFileAsync = promisify(execFile);

const REPO = join(import.meta.dirname, "..", "..");

/** The embedded client bundle - gitignored, so it is whatever the last build
 *  left behind, which is the whole reason this file exists. */
const BUNDLE_PATH = join(REPO, "src", "server", "client-bundle.generated.ts");

/** Run roots the durable-path fixture (M5.5) leaves outside the temp dir. A day
 *  is longer than any run, so nothing in progress can be swept. */
const RUN_ROOT = join(homedir(), ".lucid-e2e");
const RUN_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The preconditions for the whole run, checked once.
 *
 * Everything here is about making a green result mean something. The client
 * bundle is gitignored and the suite drives the shell it contains, so without a
 * gate a pass can be a pass against whatever the last build left on disk. The
 * logic lives in `gate.ts` so it can be tested; this file is the wiring, and
 * says out loud what it did so the run's own log shows which bundle was judged.
 */
const globalSetup = async (): Promise<void> => {
  // FIRST, before anything expensive: one run at a time. This suite's
  // teardown kills every lucid process on the machine, so a second run - even
  // one filtered spec - reaps the servers this one is mid-test on, and the
  // victim fails on a timeout indistinguishable from a flake. Two runs were
  // reported red that way before anyone looked at why.
  const claim = claimExclusiveRun();
  if (!claim.ok) throw new Error(`[e2e setup] ${claim.reason}`);
  const log = (message: string): void => console.log(`[e2e setup] ${message}`);

  const freshness = await ensureFreshBundle({
    bundlePath: BUNDLE_PATH,
    sources: BUNDLE_SOURCES.map((s) => join(REPO, ...s.split("/"))),
    build: async () => {
      await execFileAsync("bun", ["run", "build:client"], { cwd: REPO });
    },
    log,
  });
  if (freshness.bundleMtimeMs !== undefined) {
    log(`bundle mtime ${new Date(freshness.bundleMtimeMs).toISOString()}`);
  }

  // Built once per run rather than per test, and skipped when it is already
  // newer than everything it is built from - CI runs `bun run build` in its own
  // step seconds earlier, so an unconditional build here compiles the binary
  // twice in every job and twice again on each platform of the nightly.
  //
  // Gated on the binary's OWN inputs since M6.2, which is the tightening the
  // previous version asked its first real consumer to make. It used to compare
  // dist/lucid against the embedded bundle alone: `compiled-binary-
  // selfinvocation` drives `dist/lucid` and the code it is about lives in
  // `src/cli/self.ts`, which that check could not see - so editing
  // `selfInvocation` left a binary from the previous commit on disk and the
  // test passed against code that is not in this one. Measured, not argued: a
  // mutation of `selfInvocation` under the old check produced "dist/lucid is
  // current" and a green run.
  // The suite's own binary, not `dist/lucid`. A human's `lucid hub --attend`
  // is a long-lived process executing that file, and this gate rebuilds on any
  // src/ change - so pointing it at `dist/lucid` would overwrite a live
  // executable on nearly every run.
  const binary = BINARY;
  const binarySources = BINARY_SOURCES.map((s) => join(REPO, ...s.split("/")));
  const binaryFreshness = await bundleFreshness(binary, binarySources);
  if (binaryFreshness.fresh) {
    log(`${binary} is current`);
  } else {
    await execFileAsync("bun", ["run", "build:binary"], {
      cwd: REPO,
      env: { ...process.env, LUCID_BINARY_OUT: binary },
    });
    // Said out loud, like the bundle's: which input forced the recompile is
    // the first question when a run rebuilds one unexpectedly.
    log(`${binary} built (older than ${binaryFreshness.newestSourcePath})`);
    // "The build exited 0" and "the artifact on disk is newer" are different
    // claims, and only the second one makes a run about the shipped binary
    // mean anything.
    const after = await bundleFreshness(binary, binarySources);
    if (!after.fresh) {
      throw new Error(
        [
          "refusing to run: the e2e binary is still older than its sources after building it.",
          `  binary: ${binary}`,
          `    mtime ${after.bundleMtimeMs === undefined ? "(missing)" : new Date(after.bundleMtimeMs).toISOString()}`,
          `  newest source: ${after.newestSourcePath}`,
          `    mtime ${after.newestSourceMtimeMs === undefined ? "(none)" : new Date(after.newestSourceMtimeMs).toISOString()}`,
          "Every assertion this run makes about the shipped artifact would be about",
          "a binary compiled from a different commit.",
        ].join("\n"),
      );
    }
  }

  const swept = await sweepStaleRoots({
    root: RUN_ROOT,
    maxAgeMs: RUN_ROOT_MAX_AGE_MS,
    now: Date.now(),
  });
  if (swept.length > 0) log(`swept ${swept.length} stale run root(s) under ${RUN_ROOT}`);
};

export default globalSetup;
