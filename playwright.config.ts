import { defineConfig, devices } from "@playwright/test";

// Playwright's own idiom - any truthy CI, not the literal string "true". An
// exact compare would silently hand `CI=1`, `act`, and an agent sandbox a run
// with no retries, no trace and no flake gate, and still exit 0: the whole
// apparatus this file exists to guarantee, absent, reporting success.
const onCI = !!process.env.CI;

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
  // PR cannot afford a tolerated flake rate: at 1% a run that size is red more
  // often than not, and the first response to a tolerated flake is to stop
  // reading the failures.
  retries: onCI ? 1 : 0,
  failOnFlakyTests: onCI,

  reporter: [
    ["list"],
    // Unconditional, including locally. `coverage-check.ts` (M0.5) cross-checks
    // every scenario the catalogue claims as covered against this file, so a
    // developer has to be able to check ledger drift without pretending to be
    // CI. `test-results/` is already gitignored, so it costs nothing.
    ["json", { outputFile: "test-results/results.json" }],
    ...(onCI ? [["html", { open: "never" }] as const] : []),
  ],

  use: {
    headless: true,
    // A CI failure is not reproducible by re-reading the log: nobody has the
    // machine. Kept for the failed attempt of a retry-pass too, which is the
    // only evidence a flake ever leaves behind.
    trace: onCI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
