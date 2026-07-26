import { defineConfig, devices } from "@playwright/test";

// CI is the run every coverage claim rests on, and it is the only place where a
// retry is affordable and a trace is worth keeping. Locally the same settings
// would just make a failing test take twice as long to tell you it failed.
const onCI = process.env.CI === "true";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // One retry, and a reporter that refuses to call the retry a pass (D-019).
  // The retry exists to produce evidence - the first attempt's trace and error -
  // not to grant amnesty; see test/e2e/reporters/no-flake.ts.
  retries: onCI ? 1 : 0,

  reporter: onCI
    ? [
        ["list"],
        ["./test/e2e/reporters/no-flake.ts"],
        // The machine-readable record. `coverage-check.ts` (M0.5) cross-checks
        // every scenario the catalogue claims as covered against these results,
        // so a catalogue row can never claim a test that does not exist.
        ["json", { outputFile: "test-results/results.json" }],
        ["html", { open: "never" }],
      ]
    : [["list"]],

  use: {
    headless: true,
    // A CI failure is not reproducible by re-reading the log: nobody has the
    // machine. The trace is the only way the failure survives the runner.
    trace: onCI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
