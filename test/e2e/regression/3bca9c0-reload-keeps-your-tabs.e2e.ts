import { expect, test } from "@playwright/test";
import { openIntoHub, startHub, type Cli, type Hub } from "../helpers.ts";

/**
 * Regression: `3bca9c0` - ⌘R keeps your tabs.
 *
 * The open tab set lived in memory only, so a reload - the most ordinary
 * gesture there is - threw away every open tab and dropped you on the pick
 * screen, with no hint that anything had been lost.
 *
 * Asserted through the reload a person actually performs, not through the
 * storage key the fix happens to use: what matters is that the tab is still
 * there afterwards and still in front.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
});

test("a reload keeps the tab that was open, instead of the pick screen", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(
    hub,
    "<!doctype html><title>Rollout checklist</title><h1>Rollout</h1>",
  );
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(page.locator('[data-test="shell-tab"]')).toContainText("Rollout checklist");

  // A bare load of the shell, which is what the roster has to survive on its
  // own: reloading the `?s=` URL proves nothing, because that query re-opens
  // the tab whether anything was remembered or not. This is the window
  // reopened, or ⌘R after the shell has taken the session id out of the URL.
  await page.goto(`http://127.0.0.1:${hub?.port}/`);

  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(page.locator('[data-test="shell-tab"]')).toContainText("Rollout checklist");
  await expect(page.locator('[data-test="shell-tab"][data-active="true"]')).toHaveCount(1);
});
