import { hook, on } from "../locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { PLAN_V1, makeCli, surfaceOf, type Cli, waitTimeoutSeconds } from "../helpers.ts";

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
  await on(page).annotationNote().fill("Backfill in one batch");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // The agent takes delivery: the turn is now running, which is the moment the
  // three voices used to speak at once.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    status: string;
  };
  expect(fb.status).toBe("feedback");
  await expect(on(page).agentWorking()).toBeVisible();

  // The card is the keeper.
  await expect(on(page).agentWorking()).toHaveCount(1);
  // And the composer line is naming a mode, not repeating the card.
  await expect(page.locator(`${hook("listener-line")}[data-mode="working"]`)).toHaveCount(0);

  // Every surface that announces a running turn, not the two the fix happened
  // to touch: the commit names three voices and the pill over the artifact is
  // the first of them. Selectors are built out here and passed IN, because
  // `page.evaluate` runs in the browser where locators.ts does not exist, and
  // spelling them in both places is how two copies drift.
  const voices = await page.evaluate(
    (sel) => {
      const count = (selector: string): number => document.querySelectorAll(selector).length;
      const surfaces = {
        transcriptCard: count(sel.card),
        composerShimmer: count(sel.shimmer),
        artifactPill: count(sel.pill),
        tabBadge: count(sel.badge),
      };
      return { surfaces, total: Object.values(surfaces).reduce((sum, n) => sum + n, 0) };
    },
    {
      card: hook("agent-working"),
      shimmer: `${hook("listener-line")}[data-mode="working"]`,
      pill: hook("surface-updating"),
      badge: `${hook("tab-attention")}[data-kind="working"]`,
    },
  );
  expect(
    voices.total,
    `a running turn is reported by ${voices.total} surfaces: ${JSON.stringify(voices.surfaces)}`,
  ).toBe(1);
  // And the one that speaks is the card, which carries elapsed time and the
  // stale state - the reason the commit kept that one and not another.
  expect(voices.surfaces.transcriptCard).toBe(1);

  await cli.run(["wait", cli.artifact, "--reply", "Batched.", "--timeout", waitTimeoutSeconds(1)]);
  await expect(on(page).agentWorking()).toHaveCount(0);
});
