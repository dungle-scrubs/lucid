import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { PLAN_V1, fullyVisibleIn, makeCli, overlaps, surfaceOf } from "../helpers.ts";
import type { Cli } from "../helpers.ts";
import { mod, on } from "../locators.ts";

/**
 * Regression: a pending artifact revision and staged picks share the surface.
 *
 * Both controls used to own `top-3 right-3`, so the cancel action covered the
 * revision status in the exact viewer state where a reviewer kept picking
 * while an agent prepared an update. Geometry is the contract: wording and
 * control widths may change, but their rectangles may never intersect.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const openSimultaneousControls = async (page: Page): Promise<void> => {
  cli = await makeCli(PLAN_V1);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toContainText("Database migration plan");

  await cli.run(["intent", cli.artifact, "revise"]);
  await expect(on(page).surfaceUpdating()).toBeVisible();

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await surface
    .locator("li")
    .nth(1)
    .click({ modifiers: [mod()] });
  await surface
    .locator("li")
    .nth(2)
    .click({ modifiers: [mod()] });
  await surface.locator("p").click({ modifiers: [mod()] });
  await expect(on(page).cancelPicks()).toBeVisible();
};

const expectSeparatedInsideStack = async (page: Page): Promise<void> => {
  const stack = on(page).surfaceControlStack();
  const updating = on(page).surfaceUpdating();
  const cancel = on(page).cancelPicks();
  const updatingBox = await on(page).surfaceUpdating().boundingBox();
  const cancelBox = await on(page).cancelPicks().boundingBox();
  expect(updatingBox).not.toBeNull();
  expect(cancelBox).not.toBeNull();
  if (updatingBox === null || cancelBox === null) return;

  expect(await overlaps(updating, cancel)).toBe(false);
  expect(updatingBox.y + updatingBox.height).toBeLessThanOrEqual(cancelBox.y);
  expect(await fullyVisibleIn(updating, stack)).toBe(true);
  expect(await fullyVisibleIn(cancel, stack)).toBe(true);
};

test("surface revision status and cancel-picks remain separate and operable", async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 900 });
  await openSimultaneousControls(page);

  await expect(on(page).cancelPicks()).toContainText("Cancel picks (4)");
  await expectSeparatedInsideStack(page);

  await page.setViewportSize({ height: 900, width: 1_440 });
  await expectSeparatedInsideStack(page);

  if (process.env.LUCID_OVERLAP_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), ".plans/02-artifact-outline/evidence");
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      fullPage: false,
      path: join(evidenceDir, "m1.1-surface-control-stack-after.png"),
    });
  }

  await on(page).cancelPicks().click();
  await expect(on(page).cancelPicks()).toHaveCount(0);
  await expect(on(page).surfaceUpdating()).toBeVisible();
});

test("stale revision status stays separated from a multiple-pick action", async ({ page }) => {
  await page.addInitScript(() => {
    const browserNow = Date.now.bind(Date);
    Date.now = () => browserNow() + 11 * 60 * 1000;
  });
  await page.setViewportSize({ height: 700, width: 900 });
  await openSimultaneousControls(page);

  await expect(on(page).surfaceUpdating()).toHaveAttribute("data-stale", "true");
  await expectSeparatedInsideStack(page);
});
