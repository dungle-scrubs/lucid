import { on } from "../locators.ts";
import { expect, test } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `80faab5`, invariant two of three - a 4xx is the server's
 * VERDICT, and a verdict is not retried.
 *
 * The commit's review found this short-circuit shipped untested (finding #31):
 * delete it and a 409 - "this address belongs to another session" - is
 * re-POSTed five times over 14 seconds, spending the human's patience to be
 * told the same thing again, while the failure card arrives 14s after the
 * click instead of now.
 *
 * The stub answers instead of the server, so the count is exact: one request,
 * one verdict, one visible failure carrying the server's own reason.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * remove the verdict throw in `transport.ts` and the counter reads 5.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

test("a 4xx verdict fails once, immediately, with the server's reason", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // Count every attempt that reaches the wire. Hand-rolled rather than
  // `stubRoute`, because the COUNT is the assertion and the helper does not
  // expose one. The stub replaces the server, so the number cannot be blurred
  // by anything real.
  let attempts = 0;
  await page.route("**/__lucid/message", (route) => {
    attempts += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "this address belongs to another artifact now" }),
    });
  });

  await on(page).messageInput().fill("does the verdict repeat?");
  await on(page).sendMessage().click();

  // The failure surfaces as a kept card - and it must say "not delivered",
  // not sit in the "sending…" limbo the retry schedule would hold it in.
  const card = on(page).unsentMessage();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("not delivered");
  await expect(card).toContainText("does the verdict repeat?");

  // The server's reason reached the human - the difference between a message
  // someone can act on and "it didn't send".
  await expect(on(page).warning()).toContainText("another artifact");

  // One attempt. The verdict was believed the first time.
  expect(attempts, `the 409 verdict was POSTed ${attempts} times`).toBe(1);
});
