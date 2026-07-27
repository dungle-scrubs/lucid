import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureFreshBundle, sweepStaleRoots } from "./gate.ts";

const execFileAsync = promisify(execFile);

const REPO = join(import.meta.dirname, "..", "..");

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
    bundlePath: join(REPO, "src", "server", "client-bundle.generated.ts"),
    // The build script counts as a source: a change to how the bundle is made
    // stales the bundle just as surely as a change to what goes into it.
    sourceDirs: [join(REPO, "client"), join(REPO, "scripts", "build-client.ts")],
    build: async () => {
      await execFileAsync("bun", ["run", "build:client"], { cwd: REPO });
    },
    log,
  });
  if (freshness.bundleMtimeMs !== undefined) {
    log(`bundle mtime ${new Date(freshness.bundleMtimeMs).toISOString()}`);
  }

  // Built once here rather than per test. Nothing under test/ runs it yet - the
  // harness spawns `bun run src/cli/main.ts` - so today this only proves the
  // binary compiles from this commit. The compiled-binary scenario is Phase 5's,
  // and it needs the artifact to already exist rather than paying for a build
  // inside a test's timeout.
  await execFileAsync("bun", ["run", "build:binary"], { cwd: REPO });
  log("dist/lucid built");

  const swept = await sweepStaleRoots({
    root: RUN_ROOT,
    maxAgeMs: RUN_ROOT_MAX_AGE_MS,
    now: Date.now(),
  });
  if (swept.length > 0) log(`swept ${swept.length} stale run root(s) under ${RUN_ROOT}`);
};

export default globalSetup;
