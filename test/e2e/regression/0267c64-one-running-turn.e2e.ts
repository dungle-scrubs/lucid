import { expect, test, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `0267c64` - one running turn, reported once.
 *
 * Three surfaces said the same thing at the same time: the pill on the
 * artifact, the working card in the transcript, and a shimmer above the
 * composer. The fix keeps the card, which carries elapsed time and the stale
 * state, and gives the composer line back to naming the MODE.
 *
 * The assertion counts the voices rather than looking for the deleted one. A
 * test that asserted `data-mode="working"` is absent would pass if a fourth
 * indicator were added under a different name; counting says what the fix
 * actually claims - that a running turn is reported once.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const openViewer = async (page: Page): Promise<{ nextCursor: string }> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return { nextCursor: session.nextCursor };
};

test("a running turn is announced in one place, not three", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('[data-test="annotation-note"]').fill("Backfill in one batch");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  // The agent takes delivery: the turn is now running, which is the moment the
  // three voices used to speak at once.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    status: string;
  };
  expect(fb.status).toBe("feedback");
  await expect(page.locator('[data-test="agent-working"]')).toBeVisible();

  // The card is the keeper.
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(1);
  // And the composer line is naming a mode, not repeating the card.
  await expect(page.locator('[data-test="listener-line"][data-mode="working"]')).toHaveCount(0);

  const voices = await page.evaluate(() => {
    const working = document.querySelectorAll('[data-test="agent-working"]').length;
    const shimmer = document.querySelectorAll(
      '[data-test="listener-line"][data-mode="working"]',
    ).length;
    return { working, shimmer, total: working + shimmer };
  });
  expect(
    voices.total,
    `a running turn is reported by ${voices.total} surfaces ` +
      `(transcript card ${voices.working}, composer shimmer ${voices.shimmer})`,
  ).toBe(1);

  await cli.run(["wait", cli.artifact, "--reply", "Batched.", "--timeout", "1"]);
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(0);
});
