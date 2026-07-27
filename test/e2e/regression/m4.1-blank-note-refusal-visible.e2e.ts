import { on } from "../locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";

/**
 * M4.1 - the blank-note refusal is visible, not silent.
 *
 * `addToQueue` refuses a whitespace-only note - correctly, a note is the whole
 * point of an annotation - but the button stayed enabled, so the refusal was
 * invisible: click, nothing, no reason, no queued card, no Send bar. The
 * refusal now shows itself the standard way: the button is disabled until
 * there is a note to queue.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * force `disabled={false}` on the button in `Panel.tsx` and the disabled
 * assertions below go red.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const openAndPick = async (page: Page): Promise<void> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
};

test("add to queue refuses a blank note visibly, and typing re-arms it", async ({ page }) => {
  await openAndPick(page);

  // An untouched composer has nothing to queue, and says so.
  await expect(on(page).addToQueue()).toBeDisabled();

  // Whitespace is not a note. This is the exact silent case the catalogue
  // reproduces: '   ', click, nothing.
  await on(page).annotationNote().fill("   ");
  await expect(on(page).addToQueue()).toBeDisabled();

  // The control: a real note arms the button, and the armed path still works
  // end to end - a refusal made visible is worthless if it also broke consent.
  await on(page).annotationNote().fill("Backfill nightly, not in one batch.");
  await expect(on(page).addToQueue()).toBeEnabled();
  await on(page).addToQueue().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(1);
});
