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

  // Both axes. The wrong ROW is what the ambiguous fingerprint produced, but
  // an identical cell has an identical sibling one column over, and a mark on
  // the right row and the wrong column is the same defect wearing a different
  // hat - a y-only comparison called that a pass.
  const centre = (box: { x: number; y: number; width: number; height: number } | null) => ({
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  });
  const want = centre(cell);
  const got = centre(mark);
  expect(
    { dx: Math.round(Math.abs(want.x - got.x)), dy: Math.round(Math.abs(want.y - got.y)) },
    `the mark landed ${Math.round(Math.abs(want.x - got.x))}px across and ` +
      `${Math.round(Math.abs(want.y - got.y))}px down from the cell that was clicked - ` +
      "an ambiguous fingerprint resolved to the wrong element",
  ).toEqual({ dx: 0, dy: 0 });
});
