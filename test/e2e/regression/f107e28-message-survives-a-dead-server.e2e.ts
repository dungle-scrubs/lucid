import { expect, test, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `f107e28` - a message cannot vanish when the server is gone.
 *
 * The composer clears on Enter, so once the POST failed the typing existed
 * nowhere: not on screen, not in the log, not in memory after a reload. The
 * person watched their message disappear and had no way to tell whether the
 * agent got it.
 *
 * Durability is the claim, so it is proved against a genuinely new page
 * instance rather than the one that did the typing - leaving the origin
 * entirely and coming back. Nothing in memory survives that.
 *
 * The revert conflicts on this tree, so the mutation is a named edit (D-046):
 * drop the `flushOutbox` call from the stream-open handler in
 * `client/chrome/session.ts`, and the kept message never leaves on reconnect.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const openViewer = async (page: Page): Promise<void> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
};

test("a message typed at a dead server is kept, and delivers itself later", async ({ page }) => {
  await openViewer(page);
  const typed = "Confirm the routing: Patch re-enters at Test, not Build.";

  // The server goes out from under the viewer.
  await cli.run(["end", cli.artifact]);
  await expect(page.locator('[data-test="reconnecting"]')).toBeVisible();

  await page.locator('[data-test="message-input"]').fill(typed);
  await page.locator('[data-test="send-message"]').click();

  // The composer has emptied, so this card is the only place the typing still
  // exists. It must exist, and it must be recoverable by hand.
  await expect(page.locator('[data-test="unsent-message"]')).toContainText(typed);
  await expect(page.locator('[data-test="message-input"]')).toHaveValue("");

  // A new JS instance, and a server that has come back: neither remembers
  // anything the first page held.
  await page.goto("about:blank");
  const reopened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(reopened.url);

  await expect(
    page.locator('[data-role="human"]').last(),
    "the message was lost when the server went away",
  ).toContainText(typed, { timeout: 20_000 });
});
