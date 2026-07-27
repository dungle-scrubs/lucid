import { on } from "../locators.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "../harness.ts";
import { surfaceOf, type Cli } from "../helpers.ts";

/**
 * M4.1 - a quick-reply chip over a half-typed note merges, never destroys.
 *
 * `queueQuickReply` used to `set({ composerNote: note })` - a plain overwrite.
 * A human three sentences into a note who clicked a chip watched their typing
 * become "What is this?" with no confirmation and no way back. The draft and
 * the canned ask now ride as ONE queued note, the draft first (D-053); an
 * empty composer keeps the old behaviour, the chip alone.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * restore the overwrite in `actions.ts` and the typed sentence vanishes from
 * the queued card.
 */

// The `cli` fixture (harness.ts) supplies the artifact and cleans up in
// `use()` teardown, whatever the test does (D-022).
const openAndPick = async (page: Page, cli: Cli): Promise<void> => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
};

test("a quick-reply over a typed note queues both, the typing first", async ({ page, cli }) => {
  await openAndPick(page, cli);

  const typed = "The backfill cadence is wrong - the events table is written hourly.";
  await on(page).annotationNote().fill(typed);

  const chip = on(page).quickReply().first();
  const canned = (await chip.textContent())?.trim() ?? "";
  expect(canned.length).toBeGreaterThan(0);
  await chip.click();

  // One card, holding every keystroke AND the canned ask.
  const card = on(page).queuedAnnotation();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(typed);
  await expect(card).toContainText(canned);

  // The control: over an EMPTY composer the chip still queues itself alone -
  // merging must not have broken the one-tap path the chips exist for.
  await surfaceOf(page).locator("#note").click();
  await expect(on(page).annotationNote()).toHaveValue("");
  await on(page).quickReply().first().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(2);
  await expect(on(page).queuedAnnotation().last()).toContainText(canned);
});
