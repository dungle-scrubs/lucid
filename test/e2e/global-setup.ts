import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BUNDLE_SOURCES, bundleFreshness, ensureFreshBundle, sweepStaleRoots } from "./gate.ts";

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
  // newer than the bundle it embeds - CI runs `bun run build` in its own step
  // seconds earlier, so an unconditional build here compiles the binary twice
  // in every job and twice again on each platform of the nightly.
  //
  // Deliberately a weaker check than the bundle's: nothing under test/ runs
  // dist/lucid yet, since the harness spawns `bun run src/cli/main.ts`. Today
  // this proves the binary COMPILES from this commit and nothing more. Phase 5
  // introduces the first real consumer and has to tighten this to the binary's
  // own inputs.
  const binary = join(REPO, "dist", "lucid");
  const binaryFresh = (await bundleFreshness(binary, [BUNDLE_PATH])).fresh;
  if (binaryFresh) {
    log("dist/lucid is current");
  } else {
    await execFileAsync("bun", ["run", "build:binary"], { cwd: REPO });
    log("dist/lucid built");
  }

  const swept = await sweepStaleRoots({
    root: RUN_ROOT,
    maxAgeMs: RUN_ROOT_MAX_AGE_MS,
    now: Date.now(),
  });
  if (swept.length > 0) log(`swept ${swept.length} stale run root(s) under ${RUN_ROOT}`);
};

export default globalSetup;
