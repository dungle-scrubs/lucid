import { on } from "./locators.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness.ts";
import { surfaceOf, type Cli } from "./helpers.ts";

/**
 * The message outbox against a server that answers badly (M5.1).
 *
 * The outbox exists because assistant-ui clears the composer on Enter, so
 * from that instant the human's typing lives in exactly one place. These
 * tests put a hostile answer on the wire and check the two things that
 * follow from that: the words survive, and the human is told enough to act.
 */

const openViewer = async (page: Page, cli: Cli): Promise<{ cursor: string }> => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return { cursor: session.nextCursor };
};

test("the server's own reason for refusing is what the panel prints", async ({ page, cli }) => {
  // A 503 is a BLIP by the transport's reading, so it spends the full retry
  // ladder before surfacing - which is the behaviour under test, not a wait
  // to be tuned away.
  test.slow();
  await openViewer(page, cli);

  await page.route("**/__lucid/message", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "the log is busy" }),
    }),
  );

  await on(page).messageInput().fill("does the reason survive the transport?");
  await on(page).sendMessage().click();

  // The server's sentence, verbatim, inside the product's own frame. "It
  // didn't send" would be true and useless: a busy log means retry works, a
  // gone hub means it never will, and only the server knows which.
  const warning = on(page).warning();
  await expect(warning).toContainText("the log is busy", { timeout: 30_000 });
  await expect(warning).toContainText("503");
  await expect(warning).toContainText("you can retry it");

  // The words are still on screen where the human can take them back.
  await expect(on(page).unsentMessage()).toContainText("does the reason survive the transport?");
});

test("Discard clears a message mid-flush, unblocks approve, and survives a reload", async ({
  page,
  cli,
}) => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // Two failed messages, made failed fast: a 4xx is a verdict, so it fails in
  // one attempt instead of spending the retry ladder.
  await page.route("**/__lucid/message", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "not now" }),
    }),
  );
  for (const text of ["first, about the cutover", "second, about the rollback"]) {
    await on(page).messageInput().fill(text);
    await on(page).sendMessage().click();
  }
  await expect(on(page).unsentMessage()).toHaveCount(2);

  // Undelivered work blocks approval: approving a review while your own
  // words are still unsent would resolve it on a record the agent cannot see.
  await expect(on(page).approve()).toBeDisabled();

  // A flush that hangs, and a human who decides not to wait.
  await page.unroute("**/__lucid/message");
  await page.route("**/__lucid/message", () => {
    /* held forever: the stuck flush */
  });
  const stuck = on(page).unsentMessage().first();
  await on(stuck).retryUnsent().click();
  await expect(on(stuck).retryUnsent()).toBeDisabled();

  // Discard works on BOTH - including the one whose own flush is stuck,
  // which is the card a global sending-flag would have frozen.
  for (const _ of [0, 1]) {
    await on(on(page).unsentMessage().last()).discardUnsent().click();
  }
  await expect(on(page).unsentMessage()).toHaveCount(0);

  // The queue being empty is what re-enables approval - the positive effect
  // that proves the discard reached the state and not just the DOM.
  await expect(on(page).approve()).toBeEnabled();

  // And it reached STORAGE: a reload rebuilds the outbox from localStorage,
  // so a message returning here would be one that discards itself on screen
  // and re-sends itself later.
  await page.goto("about:blank");
  await page.goto(session.url);
  await expect(on(page).unsentMessage()).toHaveCount(0);
  await expect(page.locator('[data-role="human"]')).toHaveCount(0);
});
