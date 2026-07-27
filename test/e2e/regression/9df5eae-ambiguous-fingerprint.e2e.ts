import { expect, test } from "@playwright/test";
import { makeCli, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `9df5eae` - an ambiguous fingerprint falls through to domPath.
 *
 * Identical status cells across table rows share a fingerprint, since each sits
 * at the same column position in its own row. The resolver took the FIRST
 * fingerprint match, so every annotation on such a cell resolved to the same
 * one and the badges stacked on row 1 instead of the row that was clicked.
 *
 * Asserted where the user sees it: the mark's position on the page, against the
 * cell that was actually clicked. A resolver test would have caught this too -
 * and did, in `test/core.test.ts` - but the row this defect wrote itself into
 * was the one on screen.
 */

const AUDIT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Audit status</title></head>
<body>
  <h1>Audit status</h1>
  <table>
    <tbody>
      <tr><td>Payments</td><td class="status">Not audited</td></tr>
      <tr><td>Identity</td><td class="status">Not audited</td></tr>
      <tr><td>Billing</td><td class="status">Not audited</td></tr>
    </tbody>
  </table>
</body>
</html>`;

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

test("an annotation on the third identical cell marks the third, not the first", async ({
  page,
}) => {
  cli = await makeCli(AUDIT);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toContainText("Audit status");

  // The third row's status cell: identical text, identical column position,
  // therefore an identical fingerprint to the other two.
  const third = surface.locator("tr:nth-child(3) td.status");
  await third.click();
  await page.locator('[data-test="annotation-note"]').fill("This one is overdue");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  const cell = await third.boundingBox();
  const mark = await surface.locator("[data-annotation-id]").first().boundingBox();
  expect(cell, "the clicked cell has no box").not.toBeNull();
  expect(mark, "no mark was drawn on the artifact").not.toBeNull();

  // Same row, not the first one. Compared by centre so a border or an inset
  // does not decide the outcome.
  const cellCentre = (cell?.y ?? 0) + (cell?.height ?? 0) / 2;
  const markCentre = (mark?.y ?? 0) + (mark?.height ?? 0) / 2;
  expect(
    Math.abs(cellCentre - markCentre),
    `the mark landed ${Math.round(Math.abs(cellCentre - markCentre))}px from the cell that was ` +
      `clicked (cell centre ${Math.round(cellCentre)}, mark centre ${Math.round(markCentre)}) - ` +
      "an ambiguous fingerprint resolved to the wrong row",
  ).toBeLessThanOrEqual(3);
});
