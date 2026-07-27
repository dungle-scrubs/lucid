import { expect, test, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `41af772` - the reopen-review path stays alive after approval.
 *
 * Approving releases the agent, and the contract used to let it `lucid end`
 * immediately. That stopped the server, so Reopen review became a dead end:
 * the POST had no receiver, and anything typed afterwards was never read. The
 * viewer answered "Reopen didn't send - try again", which was a lie - trying
 * again could not work.
 *
 * Asserted on the thing the person is left with: after approving, reopening
 * either works, or says what the way back actually is. Silence and a false
 * "try again" are the two failures.
 *
 * The revert conflicts on this tree, so the mutation is a named edit (D-046):
 * delete the `status === "ended"` branch in `reopenReview`
 * (`client/chrome/actions.ts`), and an ended session answers "try again"
 * again.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const openViewer = async (page: Page): Promise<string> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return session.nextCursor;
};

test("reopening a review after the session ended explains the way back", async ({ page }) => {
  await openViewer(page);

  await page.locator('[data-test="approve"]').click();
  await expect(page.locator('[data-test="reopen"]')).toBeVisible();

  // The agent takes approval as a release and ends the session - the sequence
  // that turned Reopen into a dead end.
  await cli.run(["end", cli.artifact]);
  await expect(page.locator('[data-test="reconnecting"]')).toBeVisible();

  await page.locator('[data-test="reopen"]').click();

  // Not "try again": the way back is for the agent to run `lucid open`, and
  // saying so is the difference between a dead end and an instruction.
  const message = page.getByText(/lucid open/i);
  await expect(
    message,
    "reopening an ended session said nothing actionable - the old copy was 'try again', which could not work",
  ).toBeVisible();
});
