/**
 * Does the regression suite actually catch anything?
 *
 * Every test in `test/e2e/regression/` claims that a shipped bug cannot come
 * back. The claim is only worth what its mutation proves: remove the fix, and
 * the test must go red. This applies each row's own mutation, runs the one test
 * that covers it, and requires the failure - then restores and requires the
 * pass.
 *
 * It also reports the rows it CANNOT prove, by name and with the measurement
 * that says why. That is the half a verifier usually omits, and omitting it is
 * how a suite comes to be trusted for coverage it does not have: four of the
 * twelve fixes here have no reachable mutation, and a script that quietly
 * skipped them would print all-green over the top of that (D-046, D-047).
 *
 * Mutations are applied in a scratch git worktree, never in the working tree,
 * so an interrupted run cannot leave a sabotaged checkout behind.
 *
 * That worktree is checked out at HEAD, so this verifies what is COMMITTED and
 * not what is in front of you. Uncommitted work is invisible to it - which is
 * the right default for a claim about the repository, and surprising exactly
 * once, when a fix you just made appears not to have taken.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGRESSIONS, type Mutation, type RegressionRow } from "../test/e2e/regression/registry.ts";

export interface Check {
  readonly row: RegressionRow;
  readonly testFile: string;
  readonly testName: string;
  readonly mutation: Exclude<Mutation, { kind: "none" }>;
}

export interface Unprovable {
  readonly sha: string;
  readonly broke: string;
  readonly why: string;
}

export interface Plan {
  readonly checks: readonly Check[];
  readonly unprovable: readonly Unprovable[];
  /** Rows whose declared shape is self-contradictory - a test with no mutation,
   *  or a mutation with no test. Neither can be verified, and neither is an
   *  honest "unprovable" either. */
  readonly contradictions: readonly string[];
}

/** Split the registry into what can be proved, what cannot, and what does not
 *  describe itself coherently. Every row lands in exactly one bucket. */
export const planFor = (rows: readonly RegressionRow[]): Plan => {
  const checks: Check[] = [];
  const unprovable: Unprovable[] = [];
  const contradictions: string[] = [];
  for (const row of rows) {
    const hasTest = Boolean(row.testFile && row.testName);
    if (hasTest && row.mutation.kind === "none") {
      contradictions.push(
        `${row.sha} names a test but declares no mutation that could make it fail`,
      );
      continue;
    }
    if (!hasTest && row.mutation.kind !== "none") {
      contradictions.push(`${row.sha} declares a mutation but names no test for it to fail`);
      continue;
    }
    if (row.mutation.kind === "none") {
      unprovable.push({ sha: row.sha, broke: row.broke, why: row.mutation.why });
      continue;
    }
    checks.push({
      row,
      testFile: row.testFile as string,
      testName: row.testName as string,
      mutation: row.mutation,
    });
  }
  return { checks, unprovable, contradictions };
};

/**
 * Apply a named edit to a file's text.
 *
 * Exactly one occurrence, or it throws. A find string that matches nothing
 * would leave the fix in place and let the test pass, which the verifier would
 * then report as proof - the precise failure this whole script exists to
 * prevent, reproduced inside it.
 */
export const applyEdit = (
  source: string,
  edit: { readonly find: string; readonly replace: string },
): string => {
  const hits = source.split(edit.find).length - 1;
  if (hits !== 1) {
    throw new Error(`the mutation matched ${hits} times, expected exactly 1: ${edit.find}`);
  }
  return source.replace(edit.find, edit.replace);
};

const run = async (
  cmd: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** The one test this row names, run in `cwd`. */
const runTest = async (cwd: string, check: Check): Promise<{ passed: boolean; output: string }> => {
  // Resolved from the lockfile'd install, not through `bunx`: `bunx <tool>`
  // falls back to the npm registry when the name is not already resolvable, so
  // a run could silently be judged by a different Playwright than the one this
  // repo pins. CI greps scripts/ for exactly this and was right to.
  const result = await run(
    [
      join(cwd, "node_modules", ".bin", "playwright"),
      "test",
      "--project=regression",
      "-g",
      check.testName,
    ],
    cwd,
  );
  return { passed: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
};

const applyMutation = async (cwd: string, mutation: Check["mutation"]): Promise<void> => {
  if (mutation.kind === "revert") {
    const result = await run(["git", "revert", "--no-commit", "--no-edit", mutation.sha], cwd);
    if (result.code !== 0) {
      throw new Error(`git revert ${mutation.sha} did not apply: ${result.stderr.trim()}`);
    }
    return;
  }
  const path = join(cwd, mutation.file);
  await writeFile(path, applyEdit(await readFile(path, "utf8"), mutation));
};

/**
 * The worktree shares `.git` and nothing else, so `node_modules` is linked in.
 * Re-linked after every restore because `git clean -fd` takes the symlink with
 * it: the link is untracked, and a trailing-slash ignore rule does not match a
 * symlink. Without this the suite cannot run at all, and every row reports as a
 * broken test - which is exactly how this script first "found" nine failures
 * that were its own.
 */
const linkDeps = async (repo: string, worktree: string): Promise<void> => {
  await run(["ln", "-sfn", join(repo, "node_modules"), join(worktree, "node_modules")], repo);
};

const restore = async (repo: string, cwd: string): Promise<void> => {
  await run(["git", "reset", "--hard", "HEAD"], cwd);
  await run(["git", "clean", "-fd"], cwd);
  await linkDeps(repo, cwd);
};

const main = async (): Promise<number> => {
  const plan = planFor(REGRESSIONS);
  const repo = join(import.meta.dirname, "..");
  const failures: string[] = [];

  if (plan.contradictions.length > 0) {
    for (const line of plan.contradictions) failures.push(line);
  }

  const worktree = await mkdtemp(join(tmpdir(), "lucid-verify-"));
  const added = await run(["git", "worktree", "add", "--detach", worktree, "HEAD"], repo);
  if (added.code !== 0) {
    console.error(`could not create a scratch worktree: ${added.stderr.trim()}`);
    return 1;
  }

  // The worktree shares .git and nothing else. Playwright, the browser and the
  // build all live in node_modules, so it is linked rather than reinstalled -
  // a second install per run would cost minutes and prove nothing.
  await linkDeps(repo, worktree);

  try {
    for (const check of plan.checks) {
      const label = `${check.row.sha} ${check.testName}`;
      await restore(repo, worktree);
      try {
        await applyMutation(worktree, check.mutation);
      } catch (error) {
        failures.push(`${label}: ${(error as Error).message}`);
        continue;
      }
      const broken = await runTest(worktree, check);
      await restore(repo, worktree);
      const fixed = await runTest(worktree, check);
      const redWhenBroken = !broken.passed;
      const greenWhenFixed = fixed.passed;

      if (!redWhenBroken) {
        failures.push(`${label}: PASSED with the fix removed - it cannot catch this regression`);
      } else if (!greenWhenFixed) {
        // The tail, not just the verdict: a test that fails in both states is
        // usually the harness, and "the test itself is broken" with no output
        // sends the reader to the wrong file.
        failures.push(
          `${label}: fails against the fix as shipped - the test itself is broken\n` +
            `      ${fixed.output.split("\n").slice(-6).join("\n      ")}`,
        );
      }
      console.log(
        `${redWhenBroken && greenWhenFixed ? "proved " : "FAILED "} ${label} ` +
          `(mutation: ${check.mutation.kind})`,
      );
    }
  } finally {
    await run(["git", "worktree", "remove", "--force", worktree], repo);
    await rm(worktree, { recursive: true, force: true });
  }

  // Said out loud, every time. These are the rows the suite does NOT prove.
  console.log(`\n${plan.unprovable.length} rows have no reachable mutation:`);
  for (const row of plan.unprovable) console.log(`  ${row.sha} - ${row.why}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} regression tests are not what they claim:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(`\n${plan.checks.length} regression tests proved by mutation`);
  return 0;
};

if (import.meta.main) process.exit(await main());
