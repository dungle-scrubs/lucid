import { expect, test } from "@playwright/test";
import { makeCli, surfaceOf } from "../helpers.ts";
import { on } from "../locators.ts";
import { outlineDebugInfo } from "../visual.ts";

/**
 * Regression: an artifact whose element count exceeds the old outline budget
 * (2_000) still projects an outline after the budget was raised.
 *
 * Before `proofElementLimit` was raised from 2_000 to 4_000, a document over
 * 2_000 elements bailed AO-004 ("item-budget-exhausted") on every cold pass and
 * the outline never appeared - a real plan document that grew past the bound
 * silently lost its table of contents. This guards the bound against regressing
 * back below a legitimate plan's size.
 */
test("an artifact over the legacy 2_000-element bound still projects an outline", async ({
  page,
}) => {
  // 2_400 elements: above the legacy 2_000 bound, below the current 4_000 one.
  const fillers = Array.from({ length: 2_390 }, (_, i) => `<p>filler ${i}</p>`).join("");
  const artifact = `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto;font-family:system-ui}</style></head><body><main><h1>Large plan</h1><h2>Context</h2><p>A</p><h2>Milestones</h2><p>B</p><h2>Risks</h2><p>C</p>${fillers}</main></body></html>`;

  await page.setViewportSize({ width: 1_440, height: 900 });
  const cli = await makeCli(artifact, { binary: true });
  try {
    const opened = (await cli.run(["open", cli.artifact])) as { url: string };
    await page.goto(opened.url);
    await expect(surfaceOf(page).locator("h1")).toBeVisible();

    // The traversal must reach the headings, not bail on the element budget.
    await expect.poll(async () => (await outlineDebugInfo(page))?.headingCount ?? 0).toBe(3);
    // The outline element is present with a real (non-ABSENT) mode. Items are
    // only in the DOM once a transient panel is opened, so the heading count
    // and the outline element's mode are the projection guard.
    await expect(on(page).artifactOutline()).toHaveAttribute("data-mode", /pinned|transient_/);
    await expect(on(page).artifactOutlineRail()).toBeVisible();
  } finally {
    await cli.cleanup();
  }
});
