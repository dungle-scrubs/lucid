import { on } from "../locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { delayRoute, makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `80faab5` - a slow send is visible while it is slow.
 *
 * This row was first closed as "no reachable mutation", on the reading that the
 * commit was about the lock refusal - and the refusal genuinely is unreachable
 * now, because `f107e28`'s outbox retries until the lock frees. The review
 * pointed out that the same commit shipped three more invariants, each of them
 * a single line, none of them tested. That made the row's `why` true of the
 * refusal and false of the commit.
 *
 * This is the first of the three: a send that is merely slow shows the person
 * something. Hiding it until failure made a slow send look exactly like a
 * swallowed one, which is the whole complaint the commit opens with.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const openViewer = async (page: Page): Promise<void> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
};

test("a send that is taking a while says so, before it has failed", async ({ page }) => {
  await openViewer(page);

  // Held long enough to cross the threshold and no longer: the point is the
  // window between "sent" and "failed", which is where a person decides
  // whether their message went anywhere.
  await delayRoute(page, "**/__lucid/message", 4_000);

  await on(page).messageInput().fill("Is this getting through?");
  await on(page).sendMessage().click();

  // Still in flight - not failed, not delivered - and visible.
  await expect(
    on(page).unsentMessage(),
    "a slow send showed nothing, so it was indistinguishable from a swallowed one",
  ).toContainText("Is this getting through?", { timeout: 10_000 });
  // IN FLIGHT, said in the product's own words. "not delivered" here would be
  // a lie about a request that is still running, and it is the word that
  // makes a human retry something already on its way.
  await expect(on(page).unsentMessage()).toContainText("sending…");
  await expect(on(page).unsentMessage()).not.toContainText("not delivered");

  // ...and when it lands the card goes, leaving exactly ONE bubble. A card
  // that outlived its own success, or a second bubble from the retry
  // schedule, are the two ways "visible" turns into "duplicated".
  await expect(on(page).unsentMessage()).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('[data-role="human"]')).toHaveCount(1);
});
