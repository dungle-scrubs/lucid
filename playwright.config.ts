import { defineConfig, devices } from "@playwright/test";

// This suite runs on the maintainer's Mac and nowhere else (D-044). There is no
// CI leg, so nothing here is conditional on one: retries, the flake gate and
// trace used to be gated on `process.env.CI`, which after the CI job was removed
// would have meant they never applied again - D-019's whole mechanism deleted by
// a condition that stopped being reachable rather than by a decision.

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.e2e\.ts$/,

  // The bundle the suite drives is gitignored, so without this a pass can be a
  // pass against whatever the last build left on disk. Teardown reaps anything
  // a fixture failed to stop, and says what it reaped.
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // One retry, and no amnesty for passing on it (D-019).
  //
  // The two are a pair. At `retries: 0` a flake is indistinguishable from a real
  // failure, so "this test flakes twice a week" is not a measurable claim. But
  // Playwright's exit code treats a retry-pass as success, so retries alone would
  // hide every flake behind a green check - worse than not retrying at all. The
  // run keeps the retry, for the first attempt's trace and error, and
  // `failOnFlakyTests` takes back the pass.
  //
  // This is deliberately not a threshold. A suite of 256 scenarios gating every
  // change cannot afford a tolerated flake rate: at 1% a run that size is red
  // more often than not, and the first response to a tolerated flake is to stop
  // reading the failures.
  retries: 1,
  failOnFlakyTests: true,

  reporter: [
    ["list"],
    // `coverage-check.ts` (M0.5) cross-checks every scenario the catalogue
    // claims as covered against this file, and since the run only happens here
    // this is the only place that check can be made at all. `test-results/` is
    // gitignored, so it costs nothing.
    ["json", { outputFile: "test-results/results.json" }],
    ["html", { open: "never" }],
  ],

  use: {
    // A failure an hour old is not reproducible by re-reading the terminal
    // scrollback. Kept for the failed attempt of a retry-pass too, which is the
    // only evidence a flake ever leaves behind.
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  /**
   * Two projects, because they answer different questions and are run at
   * different moments (D-006).
   *
   * `regression` holds one test per shipped fix, each written from the bug
   * report and verified by reverting the fix. It is the project you run before
   * pushing: small, fast, and every failure in it is a bug a user already hit
   * once. Its budget is 90 seconds - not a wish, a constraint on what may be
   * added to it.
   *
   * `chromium` is everything else: the scenario suite, which grows to cover the
   * catalogue and takes minutes rather than seconds.
   *
   * The split is by directory so it cannot drift. A file under
   * `test/e2e/regression/` is in the regression project by living there, and
   * `testIgnore` keeps it from also running as part of the main suite, which
   * would double every regression test's cost and its entry in the report.
   */
  projects: [
    {
      name: "regression",
      testMatch: /regression\/.*\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /regression\//,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
