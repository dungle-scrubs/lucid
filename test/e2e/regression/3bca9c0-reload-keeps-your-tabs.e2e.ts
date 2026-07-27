import { hook, on } from "../locators.ts";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("a reload keeps the tabs that were open, and the one in front", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(
    hub,
    "<!doctype html><title>Rollout checklist</title><h1>Rollout</h1>",
  );
  cli = opened.cli;

  // TWO tabs. With one, "the active tab survived" is unavoidable - there is
  // nothing else it could be - so tab activation and project scope, two of the
  // three things the commit says it restores, went untested.
  const second = join(cli.dir, "handover.html");
  await writeFile(second, "<!doctype html><title>Handover notes</title><h1>Handover</h1>");
  await cli.run(["open", second]);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await on(page).pickerRow().first().click();
  await expect(on(page).shellTab()).toHaveCount(2);

  // Put a specific one in front, so "restored" has to mean the right one.
  await page.locator(hook("shell-tab"), { hasText: "Rollout checklist" }).first().click();
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText(
    "Rollout checklist",
  );

  // A bare load of the shell, which is what the roster has to survive on its
  // own: reloading the `?s=` URL proves nothing, because that query re-opens
  // the tab whether anything was remembered or not. This is the window
  // reopened, or ⌘R after the shell has taken the session id out of the URL.
  await page.goto(`http://127.0.0.1:${hub?.port}/`);

  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(
    page.locator(`${hook("shell-tab")}[data-active="true"]`),
    "the roster came back but the wrong tab was in front",
  ).toContainText("Rollout checklist");
});
