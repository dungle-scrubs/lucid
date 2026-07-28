import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
// `invoke` is off the barrel because it takes a raw env; this file needs one -
// `LUCID_OPEN_LOG` is what makes a would-be browser launch observable, and the
// `makeCli` fixture deliberately pins discovery at a dead hub port.
import { invoke } from "./cli.ts";
import {
  inEveryWindow,
  makeCli,
  PLAN_V1,
  secondWindow,
  startHub,
  type Cli,
  type Hub,
  type ShellWindow,
} from "./helpers.ts";
import { hook, on } from "./locators.ts";

/**
 * `lucid open` reaches EVERY window, and pops none of them (M6.2, K).
 *
 * Two shells over one hub is the ordinary desk: a window per screen, or one
 * left open on another space. The hub broadcasts `open-tab` to its listing
 * subscribers, and a broadcast that reached only the window that happened to
 * subscribe first would be invisible in a one-window suite - the second window
 * simply never learns, and the human finds a tab missing in the place they were
 * looking.
 *
 * The other half is what does NOT happen. `open` skips the browser launch when
 * a shell took the session (`shells > 0`), and "no window appeared" is exactly
 * the assertion a headless suite cannot make by watching - so it is made
 * through the D-015 seam instead, which records every would-be launch.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
let other: ShellWindow | undefined;

test.afterEach(async () => {
  await other?.close();
  other = undefined;
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
});

/** Every launch `open` would have made, in order. */
const launches = async (path: string): Promise<{ how: string; url: string }[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { how: string; url: string });

test("lucid open surfaces the tab in every open shell and pops no browser", async ({
  browser,
  page,
}) => {
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  const openLog = join(cli.dir, "open.ndjson");
  const env = { ...hub.env, LUCID_IDLE_MS: "0", LUCID_OPEN_LOG: openLog };

  // First open with NO window connected. This is the control for the whole
  // test: it proves the seam records a launch at all, so "nothing was recorded"
  // below is a statement about `open`'s decision rather than about a log
  // nobody was writing to.
  const first = (await invoke(["open", cli.artifact], {
    cwd: cli.dir,
    timeout: 30_000,
    env,
  })) as { url: string };
  expect(first.url).toContain(`127.0.0.1:${hub.port}/?s=`);
  expect(
    (await launches(openLog)).length,
    "no launch was recorded for an open with no shell connected - the seam is not writing",
  ).toBe(1);

  // Two windows over the one hub: the ?s= entry the CLI printed, and a plain
  // one at the hub root, which is what a second screen has open.
  await page.goto(first.url);
  await expect(on(page).shellTab()).toHaveCount(1);
  other = await secondWindow(browser, hub.url);
  await expect(
    on(other.page).sessionsList().or(on(other.page).pickerProject()).first(),
  ).toBeVisible({ timeout: 15_000 });
  const before = await on(other.page).shellTab().count();

  // A second artifact, opened from a terminal while both windows are up.
  const rollout = join(cli.dir, "rollout.html");
  await writeFile(
    rollout,
    PLAN_V1.replace("<title>Migration plan</title>", "<title>Rollout checklist</title>"),
  );
  await invoke(["open", rollout], { cwd: cli.dir, timeout: 30_000, env });

  // Every window gains it - not just the one that subscribed first.
  await inEveryWindow([page, other.page], async (window) => {
    await expect(window.locator(hook("shell-tab"), { hasText: "Rollout checklist" })).toHaveCount(
      1,
    );
  });
  // ...and the second window gained a tab it did not have, which is the
  // difference between "the broadcast arrived" and "it was already there".
  expect(await on(other.page).shellTab().count()).toBe(before + 1);

  // Nothing was launched. A shell took the session, so `open` must not put a
  // browser window next to a window that is already showing the tab.
  const recorded = await launches(openLog);
  expect(
    recorded.length,
    `open popped a browser next to two live shells: ${JSON.stringify(recorded)}`,
  ).toBe(1);

  await cli.run(["end", rollout]).catch(() => undefined);
});
