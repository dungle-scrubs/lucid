// Running the CLI, and reading what it answered.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
 */
/** Exported for `hub.ts`, which rebinds a CLI to a running hub's env. */
export const invoke = async (
  args: readonly string[],
  options: Parameters<typeof execFileAsync>[2] & { timeout?: number },
): Promise<Record<string, unknown>> => {
  let outcome: CliOutcome;
  try {
    const { stdout, stderr } = await execFileAsync("bun", ["run", MAIN, ...args], options);
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

export interface Cli {
  readonly dir: string;
  readonly artifact: string;
  run(args: string[], timeoutMs?: number): Promise<Record<string, unknown>>;
  write(html: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** Spawn a `lucid` CLI invocation (dev mode via bun) and parse its JSON output. */
export const makeCli = async (initialHtml: string): Promise<Cli> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-e2e-"));
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, initialHtml);

  const run = async (args: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> =>
    invoke(args, {
      cwd: dir,
      timeout: timeoutMs,
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

  return {
    dir,
    artifact,
    run,
    write: (html: string) => writeFile(artifact, html),
    cleanup: async () => {
      try {
        await execFileAsync("bun", ["run", MAIN, "end", artifact], {
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
