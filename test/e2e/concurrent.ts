// Running several CLI invocations at once, and killing one mid-flight.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones add tests, never harness: an agent that needs to change something
// here has been scoped wrong, and the split is what makes that visible rather
// than a merge conflict nobody reads.

import { spawn, type ChildProcess } from "node:child_process";
import { MAIN } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";

/**
 * A CLI invocation running in the background, with its output collected and
 * its process reachable.
 *
 * `invoke` (cli.ts) is the right tool for a command you wait for. This exists
 * for the two things it cannot do: hold several invocations in flight at once
 * so they contend for the same log, and SIGKILL one before it prints - which
 * is the only way to ask whether a killed reader CONSUMED the batch it was
 * reading.
 */
export interface Running {
  readonly child: ChildProcess;
  /** Resolves when the process exits, with everything it wrote. */
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** SIGKILL, for the scenarios about a reader that dies mid-read. */
  kill(): void;
}

export const startCli = (
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = harnessEnv(cwd),
): Running => {
  const child = spawn("bun", ["run", MAIN, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done, kill: () => child.kill("SIGKILL") };
};

/**
 * Run several invocations AT ONCE and wait for all of them.
 *
 * Spawned in one synchronous pass before anything is awaited, which is what
 * makes them genuinely concurrent: awaiting each `startCli` in turn would
 * serialize them and the contention these scenarios exist to create would
 * never happen.
 */
export const runConcurrently = async (
  cwd: string,
  invocations: readonly (readonly string[])[],
  env?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }[]> => {
  const running = invocations.map((args) => startCli(cwd, args, env));
  return Promise.all(running.map((r) => r.done));
};

/** Parse a CLI stdout that is meant to be one JSON document. Returns undefined
 *  rather than throwing, so a caller can assert on the shape of a failure. */
export const parsed = <T>(stdout: string): T | undefined => {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
};
