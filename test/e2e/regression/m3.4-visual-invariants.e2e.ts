import { on } from "../locators.ts";
import { expect, test } from "../harness.ts";
import {
  contrastRatio,
  fullyVisibleIn,
  isHittable,
  overlaps,
  scrollsSideways,
  settled,
  surfaceOf,
} from "../visual.ts";

/**
 * M3.4 - the five visual invariants, exercised against the real chrome.
 *
 * They exist because thirty suites are about to ask the same five questions,
 * and thirty hand-rolled answers would drift into thirty slightly different
 * definitions of "overlaps". This file is what stops them shipping as five
 * plausible functions nobody has run: each is used here against the product,
 * in both directions where the product offers one.
 *
 * Not a scenario test - it asserts nothing about Lucid's behaviour. It asserts
 * that the instruments read correctly, which is the thing every scenario test
 * after it will be trusting.
 */

test("the instruments read the real chrome correctly", async ({ page, cli }) => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toContainText("Database migration plan");
  await settled(page);

  // OVERLAP: an element always overlaps itself, and the composer does not
  // overlap the artifact surface beside it. Both directions, because a
  // predicate that always returns false passes the second half alone.
  const composer = on(page).messageInput();
  expect(await overlaps(composer, composer), "an element must overlap itself").toBe(true);
  expect(
    await overlaps(composer, page.locator('iframe[title="artifact surface"]')),
    "the composer and the artifact surface are side by side, not on top of each other",
  ).toBe(false);

  // SIDEWAYS SCROLL: the thread is a vertical record, so this is 0 or less.
  expect(await scrollsSideways(on(page).threadViewport())).toBeLessThanOrEqual(0);

  // CONTAINMENT: the composer is inside the panel that holds it.
  expect(await fullyVisibleIn(composer, on(page).threadViewport().locator(".."))).toBe(true);

  // CONTRAST: the composer's own text against whatever is actually behind it.
  // 4.5 is the WCAG AA threshold for body text; the chrome's own tokens are
  // the thing under test here, not an artifact's.
  const ratio = await contrastRatio(composer);
  expect(ratio, `composer text contrast is ${ratio.toFixed(2)}:1`).toBeGreaterThan(4.5);

  // HIT TEST: the send button is what a click at its centre would reach.
  expect(await isHittable(on(page).sendMessage())).toBe(true);
});
