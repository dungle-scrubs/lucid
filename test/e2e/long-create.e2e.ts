import { hook, on } from "./locators.ts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { BINARY, PLAN_V1, openIntoHub, startHub, type Cli, type Hub } from "./helpers.ts";

/**
 * A long create turn never claims failure (plan 07, Gate 2->3).
 *
 * The claim the gate is about is a UI claim, so this drives a browser rather
 * than reading the event stream: the question is not only whether the hub
 * emits `create-failed`, it is whether anything in the dialog decides on its
 * own that a turn taking a long time has died. Nothing may infer failure from
 * elapsed time where a signal exists, and the signal here is process exit.
 *
 * The duration is an env knob because the gate asks for EIGHT MINUTES and the
 * suite cannot pay that on every run. The default keeps this honest at ~20s in
 * CI; the recorded measurement is this same test with the knob turned up:
 *
 *   LUCID_LONG_CREATE_S=480 bunx playwright test long-create --project=chromium
 *
 * One test, two durations - so the thing that was measured at 8 minutes is the
 * thing that runs on every commit, rather than a script that rots beside it.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
let fixtures: string | undefined;

/** How long the fake harness runs before exiting cleanly. */
const RUN_S = Number(process.env.LUCID_LONG_CREATE_S ?? "20");

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  await cli?.cleanup();
  cli = undefined;
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
  fixtures = undefined;
});

test("a long create turn keeps reporting progress and never claims failure", async ({ page }) => {
  // Playwright's own timeout must outlast the harness, or the measurement
  // would be bounded by the test runner rather than by the product.
  test.setTimeout((RUN_S + 120) * 1000);

  fixtures = await mkdtemp(join(tmpdir(), "lucid-longcreate-"));
  const exe = join(fixtures, "slow-harness");
  const artifact = "slow.html";
  // Authors the artifact at the very end, so the turn is genuinely productive
  // rather than a process that merely sleeps: a create that produces nothing
  // would be a different (and weaker) test.
  // The target path rides in the prompt ("...to exactly <path>."), which is
  // what the real harness reads it from too - and the prompt's last
  // instruction is `lucid open <artifact>`, so the stub runs it. Skipping that
  // step is what makes a stub unrepresentative: the tab appears because the
  // agent opens the artifact, not because the hub watches the filesystem.
  await writeFile(
    exe,
    `#!/bin/sh\nsleep ${RUN_S}\ntarget=$(printf '%s' "$1" | grep -o "/[^ ]*${artifact}" | head -1)\nmkdir -p "$(dirname "$target")"\nprintf '%s' '<!doctype html><html><head><title>authored</title></head><body><h1>authored</h1></body></html>' > "$target"\n${BINARY} open "$target" >/dev/null 2>&1\nexit 0\n`,
  );
  await chmod(exe, 0o755);

  hub = await startHub({
    attend: true,
    harnesses: { default: "slow", harnesses: { slow: { spawn: [exe, "{prompt}"] } } },
  });
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  const created = join(cli.dir, ".lucid", artifact);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await page.evaluate((root) => localStorage.setItem("lucid.createRoot", root), cli.dir);
  await on(page).tabAdd().click();
  await on(page).newArtifact().click();
  await on(page).createName().fill(artifact);
  await on(page).createPrompt().fill("take your time");
  await on(page).createSubmit().click();

  await expect(on(page).createRunningLog()).toBeVisible({ timeout: 20_000 });

  // Sample across the whole run rather than only at the end: a dialog that
  // gave up at minute six and recovered by minute eight would pass an
  // end-state assertion and still be the defect this gate is about.
  const samples = 8;
  const every = Math.max(1, Math.floor((RUN_S * 1000) / samples));
  for (let i = 0; i < samples; i++) {
    await page.waitForTimeout(every);
    // Never a failure, never the silent branch - at any point in the run.
    await expect(page.locator(hook("create-failed-tail"))).toHaveCount(0);
    await expect(page.locator(hook("create-silent"))).toHaveCount(0);
    // And still telling the human where to watch it.
    await expect(on(page).createRunningLog()).toBeVisible();
  }

  // The turn was productive, not merely asleep: its artifact is on disk...
  await expect
    .poll(async () => await readFile(created, "utf8").catch(() => ""), {
      timeout: 60_000,
    })
    .toContain("authored");
  // ...and it lands as a tab of its own, which is how a create finishes. No
  // existing test covered the SUCCESS path of create - every other one asserts
  // a refusal or a failure - so this is the first thing to prove a long turn
  // ends the way a short one does.
  await expect(on(page).shellTab()).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator(hook("create-failed-tail"))).toHaveCount(0);
  await expect(page.locator(hook("create-silent"))).toHaveCount(0);
});
