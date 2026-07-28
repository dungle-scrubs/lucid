import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// `invoke` is off the barrel because it takes a raw env, and this test needs
// three: the hub port `app` should use, a scan root that is not the human's
// ~/dev, and the launch log that makes a would-be window observable.
import { invoke } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";
import { fixedHubPort, killHubOnPort, makeCli, PLAN_V1, type Cli } from "./helpers.ts";
import { on } from "./locators.ts";

/**
 * `lucid app` is a front door, not a window factory (M6.2, O).
 *
 * The command is what a Dock icon runs, so it is pressed repeatedly by
 * definition. Every press that opens another window leaves a person with five
 * identical shells and no way to tell which one is theirs - and the failure is
 * silent, because each individual window works.
 *
 * The clause that carries it is the reconnect beat. `app` decides by asking the
 * hub how many shells are connected, and a window that survived a hub restart
 * is NOT connected for the moment its stream takes to come back - so a decision
 * made on the first probe stacks a window every time the hub is replaced, which
 * is exactly when `app` gets pressed. `runApp` waits out that beat whether or
 * not the hub answered the first probe, and this is the test of it.
 *
 * The hub here is spawned by the PRODUCT (`app` starts its own, detached), not
 * by `startHub`, so it carries neither signature `gate.ts` reaps by. This file
 * kills it on the way out.
 */

let cli: Cli | undefined;
const port = fixedHubPort();

test.afterEach(async () => {
  await killHubOnPort(port);
  await cli?.cleanup();
  cli = undefined;
});

/** Every launch `app` would have made, in order. */
const launches = async (path: string): Promise<{ how: string; url: string }[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { how: string; url: string });

interface AppResult {
  readonly hub: string;
  readonly app: string | boolean;
  readonly shells?: number;
  readonly status: string;
}

test("lucid app run repeatedly never stacks browser windows", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const openLog = join(cli.dir, "app-launches.ndjson");
  const env = {
    ...harnessEnv(cli.dir),
    LUCID_HUB_PORT: String(port),
    // The hub `app` spawns inherits this: without it the detached daemon scans
    // the developer's real ~/dev and lists their own sessions.
    LUCID_HUB_ROOTS: cli.dir,
    LUCID_OPEN_LOG: openLog,
  };
  // Nothing may be listening before the first press, or "app started a hub"
  // would be a claim about somebody else's process.
  await killHubOnPort(port);

  // Press one: no hub, no window. It starts the daemon and opens the app
  // window - and RECORDS the launch, which is the control for every "nothing
  // was launched" below.
  const first = (await invoke(["app"], {
    cwd: cli.dir,
    timeout: 40_000,
    env,
  })) as unknown as AppResult;
  expect(first.status).toBe("running");
  expect(first.app, "the first press reported a window that was already open").not.toBe(
    "already-open",
  );
  expect(first.hub).toContain(`127.0.0.1:${port}`);
  // The baseline is counted rather than assumed to be 1: under LUCID_NO_OPEN
  // one press records TWO lines, because `openChromeApp` records its skip and
  // then returns false, so the default-browser fallback records another. What
  // matters here is only that a press which opens a window MOVES this number -
  // that is what makes "it did not move" below a measurement.
  const baseline = (await launches(openLog)).length;
  expect(
    baseline,
    "the first press launched nothing - the seam is not recording, so the assertions below are free",
  ).toBeGreaterThan(0);

  // The window the first press stood for. An empty hub shows the add-a-folder
  // screen; its presence means this window is connected and counted.
  await page.goto(first.hub);
  await expect(on(page).addFolderType().first()).toBeVisible();

  // Presses two, three and four, against a live hub with a live window.
  for (const press of [2, 3, 4]) {
    const again = (await invoke(["app"], {
      cwd: cli.dir,
      timeout: 40_000,
      env,
    })) as unknown as AppResult;
    expect(again.app, `press ${press} did not see the open window`).toBe("already-open");
    expect(again.shells ?? 0, `press ${press} saw no connected shell`).toBeGreaterThan(0);
    expect(
      (await launches(openLog)).length,
      `press ${press} stacked a second window on the one already open`,
    ).toBe(baseline);
  }

  // And the case the beat exists for: the hub is gone, the window is still
  // there and mid-retry, and `app` is pressed. The hub it starts answers
  // immediately with zero shells - a decision taken there opens a window on
  // top of the one that is about to come back.
  await killHubOnPort(port);
  // A beat of the harness's own, and it is not padding. Chrome reconnects a
  // dropped EventSource on its own schedule - 3s, measured - while the
  // product's beat is 2.5s counted from the moment the NEW hub answers. Press
  // at the instant of the kill and the two land within tens of milliseconds of
  // each other (measured: the press returns at ~2995ms, the window comes back
  // at ~3000ms), which is a coin toss rather than a test. Waiting here spends
  // part of the browser's retry window before `app` starts, so the beat has
  // over a second of margin in BOTH directions: the real product answers
  // already-open comfortably, and a build with the beat removed decides a
  // second before the window can possibly return. The margin, not the delay,
  // is the point.
  await page.waitForTimeout(1200);
  const pressedAt = Date.now();
  const afterRestart = (await invoke(["app"], {
    cwd: cli.dir,
    timeout: 40_000,
    env,
  })) as unknown as AppResult;
  // Reported on failure rather than logged on success: how long the press took
  // is the first question when this goes red, and a build with no beat answers
  // in under a second (measured: 850ms, against 1.7-2.0s for the real one).
  const pressMs = Date.now() - pressedAt;
  expect(
    afterRestart.app,
    `a hub restart stacked a second window on the surviving one - the press took ${pressMs}ms`,
  ).toBe("already-open");
  expect(afterRestart.shells ?? 0).toBeGreaterThan(0);
  expect((await launches(openLog)).length, "the restart press launched a window").toBe(baseline);
});
