// Running the CLI, and reading what it answered.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type CliOutcome, interpretCliResult } from "./cli-result.ts";
import { harnessEnv } from "./harness-env.ts";

const execFileAsync = promisify(execFile);

/**
 * Run the CLI and interpret what came back.
 *
 * `execFile` rejects with `Command failed` and hangs the exit code, stdout and
 * stderr off the error object where nobody looks, so the rejection is caught
 * here and turned into the full outcome before `interpretCliResult` judges it.
 * A genuine spawn failure - no such binary - is re-thrown untouched, because
 * that is not the CLI answering at all.
 *
 * Exported only for `hub.ts`, which rebinds a CLI to a running hub's env. It is
 * deliberately NOT on the `helpers.ts` barrel: it takes a raw `env`, and every
 * other caller should be going through `makeCli`, which contains one.
 */
/**
 * A `wait` deadline, in seconds, scaled for the machine it runs on (D-020).
 *
 * A literal in a test body cannot be scaled. The number that is comfortable on
 * an idle laptop is the first thing to flake on a loaded one, and the failure
 * arrives as "the agent never answered" rather than "this deadline was too
 * short" - so the test gets rewritten instead of the timeout.
 *
 * The base is what the scenario needs when nothing is contending. Everything
 * else is the harness's business: more workers means more processes competing
 * for the same cores, and `LUCID_E2E_TIMEOUT_SCALE` is the escape hatch for a
 * machine nobody anticipated.
 */
export const waitTimeoutSeconds = (base: number): string => {
  // `LUCID_E2E_TIMEOUT_SCALE` and nothing else.
  //
  // An earlier version also multiplied by 1.5 when `TEST_PARALLEL_INDEX > 0`,
  // on the belief that it was a worker COUNT. It is the 0-based index of the
  // worker SLOT, so that gave slot 0 a tight deadline and every other slot a
  // loosened one - a per-slot lottery where a test flakes on slot 0 and not on
  // slot 2 - and with `workers: 1` in the config the branch was unreachable
  // anyway. Dead code that read as protection.
  //
  // The knob moves THIS deadline only. `playwright.config.ts`'s `timeout` and
  // `expect.timeout` are separate numbers; on a machine slow enough to need
  // the scale, they need raising too, and doing that silently from here would
  // hide which budget a run actually died on.
  const raw = process.env.LUCID_E2E_TIMEOUT_SCALE;
  // `parseFloat("3x")` is 3, which silently half-applies a typo. Require the
  // whole string to be a number.
  const scale = raw !== undefined && /^\d+(\.\d+)?$/.test(raw) ? Number.parseFloat(raw) : 1;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return String(Math.max(1, Math.ceil(base * factor)));
};

export const invoke = async (
  args: readonly string[],
  options: Parameters<typeof execFileAsync>[2] & { timeout?: number; binary?: boolean },
): Promise<Record<string, unknown>> => {
  // `binary` is the harness's, not execFile's. Split rather than passed
  // through: node ignores unknown option keys today, which is exactly the kind
  // of thing that stops being true in a major version.
  const { binary, ...exec } = options ?? {};
  const [command, argv] = spawnedAs(args, binary === true);
  let outcome: CliOutcome;
  try {
    const { stdout, stderr } = await execFileAsync(command, argv, exec);
    outcome = { argv: args, code: 0, signal: null, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      signal?: NodeJS.Signals;
      killed?: boolean;
    };
    // `code` is a number for an exit, a string like ENOENT for a spawn failure.
    const code = typeof failed.code === "number" ? failed.code : null;
    const signal = failed.signal ?? null;
    if (code === null && signal === null) throw error;
    outcome = {
      argv: args,
      code,
      signal,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      killed: failed.killed === true,
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    };
  }
  return interpretCliResult(outcome);
};

const REPO = join(import.meta.dirname, "..", "..");
/** The CLI entrypoint, exported so a suite can spawn a long-running invocation
 *  (a blocked `wait`) with an env of its own. */
export const MAIN = join(REPO, "src", "cli", "main.ts");

/**
 * The suite's OWN compiled binary - the same `bun build --compile` artifact a
 * user gets as `dist/lucid`, built to a different path, and never `dist/lucid`
 * itself: that one is what a human RUNS (`lucid hub --attend` holds it open
 * for days), and rebuilding it under a running process overwrites a live
 * executable (D-081).
 *
 * It is not the same program as `bun run src/cli/main.ts`, and the difference
 * is not cosmetic - `selfInvocation` (src/cli/self.ts) reads
 * `process.argv[1]`, which is the entry SCRIPT in dev and the first user
 * ARGUMENT in the binary, so every path that re-invokes the CLI as a child
 * forks here. `global-setup.ts` builds this every run and gates it on the
 * sources it is built from.
 */
export const BINARY = join(REPO, "dist", "lucid-e2e");

/**
 * The command line a CLI invocation actually runs as.
 *
 * One function so dev mode and the binary cannot drift apart in the four places
 * that spawn: the args a caller passes are identical either way, which is the
 * whole point - a test written against `bun run main.ts` becomes a test of the
 * shipped artifact by flipping one flag.
 */
const spawnedAs = (args: readonly string[], binary: boolean): [string, string[]] =>
  binary ? [BINARY, [...args]] : ["bun", ["run", MAIN, ...args]];

export interface Cli {
  readonly dir: string;
  readonly artifact: string;
  run(args: string[], timeoutMs?: number): Promise<Record<string, unknown>>;
  /** `run`, but from a caller-chosen working directory - for scenarios about
   *  path resolution itself (a relative artifact from a subdirectory, a bare
   *  name from a stranger's cwd). Same isolated env as `run`; only cwd moves. */
  runFrom(cwd: string, args: string[], timeoutMs?: number): Promise<Record<string, unknown>>;
  write(html: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CliOptions {
  /**
   * Drive the COMPILED binary (`dist/lucid-e2e`) instead of `bun run
   * src/cli/main.ts` - same commands, same env, the artifact a user installs.
   *
   * Additive on purpose (D-014): every existing caller keeps dev mode, and the
   * scenarios about the shipped artifact ask for it explicitly rather than the
   * suite guessing which one it is testing.
   */
  readonly binary?: boolean;
}

/** Spawn a `lucid` CLI invocation (dev mode via bun, or the compiled binary)
 *  and parse its JSON output. */
export const makeCli = async (initialHtml: string, options: CliOptions = {}): Promise<Cli> => {
  // REALPATH'd: identity is the artifact's real path (plan 05, M1.1), so a
  // fixture rooted at /tmp (a symlink to /private/tmp on macOS) would hand the
  // suite one spelling while every product surface reports the other.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-e2e-")));
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, initialHtml);

  const runFrom = async (
    cwd: string,
    args: string[],
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> =>
    invoke(args, {
      cwd,
      timeout: timeoutMs,
      ...(options.binary === true ? { binary: true } : {}),
      env: {
        // The whole child environment, not a patch over `process.env` -
        // `harnessEnv` has to be able to REMOVE a name, not only add one.
        ...harnessEnv(dir),
        // A hub the USER happens to be running would hijack `open` into
        // daemon mode (a tab in their shell) and change what these tests
        // see. Point discovery at a dead port so the dedicated-server path
        // is taken deterministically; shell.e2e.ts overrides this with its
        // own isolated hub.
        LUCID_HUB_PORT: "1",
      },
    });

  const run = (args: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> =>
    runFrom(dir, args, timeoutMs);

  return {
    dir,
    artifact,
    run,
    runFrom,
    write: (html: string) => writeFile(artifact, html),
    cleanup: async () => {
      try {
        // Ended by the same program that opened it: a session opened by the
        // binary has a descriptor naming the binary's own detached `__serve`,
        // and cleanup that forked to dev mode would be testing a third thing.
        const [command, argv] = spawnedAs(["end", artifact], options.binary === true);
        await execFileAsync(command, argv, {
          cwd: dir,
          env: harnessEnv(dir),
        });
      } catch {
        /* already ended */
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
};
