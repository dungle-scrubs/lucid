import { on } from "../locators.ts";
import { expect, test } from "../harness.ts";
import { delayRoute, surfaceOf } from "../helpers.ts";

/**
 * Regression: `80faab5`, invariant three of three - a flush stuck on ONE
 * message disables that card's controls and no other's.
 *
 * The commit's review found this shipped untested: the per-card check is
 * `outboxSendingId === message.id`, and flattening it back to the
 * global `outboxSending` flag leaves every card reading "Sending…" during any
 * flight - the one control a failed send leaves you, unusable on all of them
 * at once.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * swap the per-id read in `Panel.tsx` for the global flag and the second
 * card's Retry is disabled while the first is in flight.
 */

test("a stuck flush disables its own card's Retry, and no other's", async ({ page, cli }) => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // Two failed messages, manufactured fast: a 409 verdict fails in one
  // attempt (the invariant the sibling test proves), so neither card spends
  // the retry schedule getting into the failed state this test starts from.
  await page.route("**/__lucid/message", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "not yet" }),
    }),
  );
  await on(page).messageInput().fill("first: the routing question");
  await on(page).sendMessage().click();
  await expect(on(page).unsentMessage()).toHaveCount(1);
  await on(page).messageInput().fill("second: the naming question");
  await on(page).sendMessage().click();
  await expect(on(page).unsentMessage()).toHaveCount(2);

  // A FAILED flush released its card: the id cleared in the same path that
  // marked it failed, so Retry is usable again. Without this, a mutation
  // that leaves outboxSendingId set after a failure - Retry frozen forever
  // on the one card that needs it - would pass everything below, because
  // the held-route window only ever ends in success.
  await expect(on(on(page).unsentMessage().first()).retryUnsent()).toBeEnabled();

  // Now the wire comes back, slowly: every POST is held 4s and then reaches
  // the REAL server. The hold is the window this test exists to look inside.
  await page.unroute("**/__lucid/message");
  await delayRoute(page, "**/__lucid/message", 4000);

  const cards = on(page).unsentMessage();
  const first = cards.first();
  const second = cards.last();
  await on(first).retryUnsent().click();

  // Inside the window: the in-flight card says so and locks its own retry...
  await expect(on(first).retryUnsent()).toBeDisabled();
  await expect(on(first).retryUnsent()).toContainText("Sending");
  // ...and the OTHER card's controls stay live. This pair is the invariant:
  // under the global-flag mutation both retries read "Sending…" together.
  await expect(on(second).retryUnsent()).toBeEnabled();
  await expect(on(second).discardUnsent()).toBeEnabled();
  // Enabled is not the claim - USABLE is. A disabled-looking button that
  // does nothing and a live one are the same pixel to a person mid-outage,
  // so the second card is actually discarded while the first hangs.
  await on(second).discardUnsent().click();
  await expect(on(page).unsentMessage()).toHaveCount(1);
  await expect(on(page).unsentMessage()).toContainText("first: the routing question");

  // Let the flush finish: the ONE message still held drains through the
  // route and its card clears - the stuck state was a window, not a
  // destination. One bubble, not two: the discard above really did take a
  // message out of the outbox rather than only off the screen.
  await expect(page.locator('[data-role="human"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('[data-role="human"]')).toContainText("first: the routing question");
  await expect(on(page).unsentMessage()).toHaveCount(0);

  // ...and the discard was DURABLE. A reload restores the outbox from
  // storage, so a card that comes back here means the discard cleared the
  // render and left the localStorage key - the message would re-send itself
  // later, which is the failure a person cannot see coming.
  await page.goto("about:blank");
  await page.goto(session.url);
  await expect(on(page).unsentMessage()).toHaveCount(0);
  await expect(page.locator('[data-role="human"]')).toHaveCount(1);
});
