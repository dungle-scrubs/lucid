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

test("the outline slot stays between top controls, bottom overlays, and the scrollbar", async ({
  page,
}) => {
  await page.setViewportSize({ height: 760, width: 1_100 });
  cli = await makeCli(PLAN_V1);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toContainText("Database migration plan");

  const region = on(page).surfaceRegion();
  await expect(region).toHaveAccessibleName("Artifact review surface");
  await expect(region).toHaveAttribute("tabindex", "-1");
  await region.evaluate((element: HTMLElement) => element.focus());
  await expect(region).toBeFocused();

  await cli.run([
    "ask",
    cli.artifact,
    "--text",
    "Which part should change?",
    "--option",
    "Backfill|Update the first step",
  ]);
  await expect(on(page).questionDrawer()).toBeVisible();

  const slot = on(page).surfaceOutlineSlot();
  const stack = on(page).surfaceControlStack();
  const drawer = on(page).questionDrawer();
  await expect(slot).toHaveCSS("pointer-events", "none");
  expect(await overlaps(slot, stack)).toBe(false);
  expect(await overlaps(slot, drawer)).toBe(false);
  expect(await fullyVisibleIn(slot, region)).toBe(true);

  const slotBox = await slot.boundingBox();
  const stackBox = await stack.boundingBox();
  const frameBox = await page.locator('iframe[title="artifact surface"]').boundingBox();
  expect(slotBox).not.toBeNull();
  expect(stackBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  if (slotBox === null || stackBox === null || frameBox === null) return;
  expect(stackBox.y + stackBox.height).toBeLessThanOrEqual(slotBox.y);
  const scrollbarSafeInset = await on(page)
    .surfaceControlLayer()
    .evaluate((element) =>
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--surface-scrollbar-safe-inset"),
      ),
    );
  expect(frameBox.x + frameBox.width - (slotBox.x + slotBox.width)).toBeGreaterThanOrEqual(
    scrollbarSafeInset,
  );

  await slot.evaluate((element) => {
    const probe = document.createElement("div");
    probe.dataset.test = "surface-outline-probe";
    probe.style.height = "2000px";
    probe.style.pointerEvents = "auto";
    probe.style.width = "100%";
    element.append(probe);
  });
  const scrollMetrics = await slot.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(await overlaps(slot, drawer)).toBe(false);

  await slot.evaluate((element) => element.firstElementChild?.remove());
  await on(page).skip().click();
  await expect(drawer).toHaveCount(0);

  await cli.cleanup();
  cli = await makeCli(PLAN_V1);
  const fresh = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(fresh.url);
  await expect(surface.locator("h1")).toContainText("Database migration plan");
  await cli.run(["intent", cli.artifact, "revise"]);
  await expect(on(page).surfaceUpdating()).toBeVisible();
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).cancelPicks()).toBeVisible();
  const freshSlot = on(page).surfaceOutlineSlot();
  expect(await overlaps(freshSlot, stack)).toBe(false);

  const receivesPointer = await freshSlot.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.tagName;
  });
  expect(receivesPointer).toBe("IFRAME");
});
