import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";

/**
 * Fails the run when a test passed only because Playwright retried it (D-019).
 *
 * Retries and flake detection pull in opposite directions. `retries: 1` is what
 * makes a flake *observable* - with zero retries a flake is indistinguishable
 * from a real failure, so "this test flakes twice a week" is not a measurable
 * claim. But Playwright's own exit code treats a retry-pass as success, so
 * turning retries on without this reporter would do the opposite: it would hide
 * every flake behind a green check, permanently.
 *
 * So the run keeps the retry (for the evidence: the first attempt's trace, its
 * error, its screenshots) and loses the amnesty. A test that needed a second
 * attempt is reported here with the attempt that failed, and the build goes red.
 *
 * This is deliberately not a threshold. A suite of 256 scenarios gating every PR
 * cannot afford a tolerated flake rate: at 1% a run of that size is red more
 * often than not, and the first response to a tolerated flake is to stop reading
 * the failures.
 */
export default class NoFlakeReporter implements Reporter {
  private root: Suite | undefined;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.root = suite;
  }

  // Async because that is the only shape Playwright accepts a status override
  // in; there is nothing to await.
  async onEnd(_result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    const flaky = (this.root?.allTests() ?? []).filter((t) => t.outcome() === "flaky");
    if (flaky.length === 0) return undefined;

    // The correlated payload: which test, where it lives, and the error from the
    // attempt that failed - not just a count. A flake reported without the first
    // attempt's error is a flake nobody can diagnose after the fact.
    const lines = [
      "",
      `${flaky.length} test${flaky.length === 1 ? "" : "s"} passed only on retry.`,
      "A test that needs a second attempt is not passing; it is flaking.",
      "",
    ];
    for (const test of flaky) {
      // `[project] › file:line › describe › title`, the same shape Playwright's
      // own reporters use, so the line is recognisable and the path is clickable.
      // titlePath() is ['', project, file, ...describes, title]; the file is
      // already in `location`, so it is dropped here rather than printed twice.
      const [, project = "", , ...titles] = test.titlePath();
      lines.push(`  [${project}] › ${location(test)} › ${titles.join(" › ")}`);
      const failed = test.results.find((r) => r.status !== "passed");
      const message = failed?.error?.message?.split("\n")[0];
      if (message) lines.push(`    attempt ${(failed?.retry ?? 0) + 1} failed: ${message}`);
      lines.push("    trace: test-results/ (retained on failure)");
    }
    lines.push("");
    console.error(lines.join("\n"));

    return { status: "failed" };
  }
}

/** `file:line` relative to the repo, so the reporter's output is clickable. */
const location = (test: TestCase): string => {
  const { file, line } = test.location;
  return `${file.replace(`${process.cwd()}/`, "")}:${line}`;
};
