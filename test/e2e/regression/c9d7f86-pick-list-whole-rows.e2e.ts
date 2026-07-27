import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeCli, PLAN_V1, startHub, type Cli, type Hub } from "../helpers.ts";

/**
 * Regression: `c9d7f86` - the pick list comes to rest on whole rows.
 *
 * A row cut in half against the container's top edge, directly under the
 * heading, read as a broken layout rather than as a scrolled list. The fix
 * snaps the list to row starts and keeps the resting row clear of the sticky
 * project header it would otherwise slide beneath.
 *
 * The assertion is geometric, not stylistic (D-003): scroll the list to a
 * deliberately mid-row offset and measure where it comes to rest. Asserting the
 * Tailwind classes instead would pass for any implementation that happened to
 * spell them the same way and fail for any that did not, which is the opposite
 * of what a regression test is for.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
/** Every artifact opened beyond `cli.artifact`. `cli.cleanup()` ends the one it
 *  owns and knows nothing about these, so without this each run leaves a live
 *  `__serve` per extra row for the global teardown to reap - which it reports,
 *  loudly and rightly, as processes that outlived the suite. */
let extras: string[] = [];

test.afterEach(async () => {
  for (const artifact of extras) {
    await cli?.run(["end", artifact]).catch(() => {});
  }
  extras = [];
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
});

/** Enough rows to overflow, in one project, without paying for a session the
 *  test does not need. The viewport is short for the same reason: the list is
 *  capped at 60vh, so a short window needs fewer rows to scroll. */
const ROWS = 5;

test("the pick list comes to rest on a whole row, never half of one", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 320 });

  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  // Opened through the CLI's OWN registry, so the hub does not know them and
  // the pick screen is what renders - the same cold start `shell.e2e.ts` uses.
  await cli.run(["open", cli.artifact]);
  for (let i = 1; i < ROWS; i++) {
    const extra = join(cli.dir, `plan-${i}.html`);
    await writeFile(extra, PLAN_V1);
    await cli.run(["open", extra]);
    extras.push(extra);
  }

  await page.goto(`http://127.0.0.1:${hub.port}/`);
  await page.locator('[data-test="add-folder-type"]').first().click();
  await page.locator('[data-test="add-folder-path"]').first().fill(cli.dir);
  await page.locator('[data-test="add-folder-path-add"]').first().click();
  await expect(page.locator('[data-test="picker-row"]')).toHaveCount(ROWS);

  const settled = await page.evaluate(async () => {
    const first = document.querySelector('[data-test="picker-row"]');
    // The scroll container is the parent of the project groups. Structural
    // rather than class-based: a class is a spelling, and D-021 rejects
    // selectors that break when someone renames one.
    const list = first?.closest('[data-test="picker-project"]')?.parentElement;
    if (!list) return { ok: false as const, reason: "no scroll container" };

    const rows = [...list.querySelectorAll('[data-test="picker-row"]')];
    if (rows.length < 3) return { ok: false as const, reason: `only ${rows.length} rows` };
    const top = (el: Element): number => el.getBoundingClientRect().top;
    const pitch = top(rows[1] as Element) - top(rows[0] as Element);
    if (list.scrollHeight <= list.clientHeight + pitch) {
      return { ok: false as const, reason: "list does not scroll" };
    }

    // Land halfway down a row: the offset a snapping list must refuse to keep.
    list.scrollTop = Math.round(pitch / 2);
    // Two frames: one for the scroll, one for the snap that follows it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // KNOWN GAP: the reference comes from the live `scroll-padding-top`, which
    // is half the fix, so `scroll-pt-0` leaves this green - only the snapping
    // half is protected. Measuring against the sticky heading instead was
    // tried and reported 44px with the fix in place, so it was withdrawn rather
    // than shipped wrong. Recorded as a finding rather than left implied.
    const padding = Number.parseFloat(getComputedStyle(list).scrollPaddingTop);
    const snapLine = list.getBoundingClientRect().top + (Number.isNaN(padding) ? 0 : padding);
    const offsets = rows.map((row) => Math.abs(top(row) - snapLine));
    return {
      ok: true as const,
      pitch,
      scrollTop: list.scrollTop,
      nearestRowToSnapLine: Math.min(...offsets),
    };
  });

  expect(settled.ok, settled.ok ? "" : `fixture did not set up: ${settled.reason}`).toBe(true);
  if (!settled.ok) return;

  // A whole row is resting against the line the list scrolls to. Half a row
  // there is the defect, and it measures as roughly half the row pitch.
  expect(
    settled.nearestRowToSnapLine,
    `list rested ${settled.nearestRowToSnapLine.toFixed(1)}px from a row start ` +
      `(scrollTop ${settled.scrollTop}, row pitch ${settled.pitch.toFixed(1)})`,
  ).toBeLessThanOrEqual(2);
});
