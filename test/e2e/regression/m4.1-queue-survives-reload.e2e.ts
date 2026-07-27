import { on } from "../locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, waitTimeoutSeconds, type Cli } from "../helpers.ts";

/**
 * M4.1 - queued annotations survive a reload, the way messages already do.
 *
 * The queue lived only in component state while the message outbox persisted
 * per-key in localStorage - so a reload kept an undelivered MESSAGE and
 * silently destroyed every queued ANNOTATION, with no warning and no recovery
 * card. The asymmetry was the finding. The queue now persists the same way
 * the outbox does (D-054): written on queue and edit, forgotten on send and
 * remove, restored on load.
 *
 * Durability is the claim, so it is proved against a genuinely new page
 * instance - and a restored item is proved still LIVE, not a husk: it can be
 * removed, and what remains still sends and resolves against its anchor.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * restore `queue: []` in `store.ts`'s initial state and every card below is
 * gone after the first reload.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const queueOn = async (page: Page, artifactSelector: string, note: string): Promise<void> => {
  await surfaceOf(page).locator(artifactSelector).click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(note);
  await on(page).addToQueue().click();
};

test("queued annotations survive a reload, and the survivors still send", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(opened.url);

  // TWO, on different elements, for the same reason the outbox test uses two:
  // one item cannot tell "persisted the queue" from "persisted the last
  // write", and each item must come back on its own key.
  const first = "Backfill nightly, not in one batch.";
  const second = "This zero-downtime assumption needs a source.";
  await queueOn(page, 'li[data-lucid-id="step-backfill"]', first);
  await queueOn(page, "#note", second);
  await expect(on(page).queuedAnnotation()).toHaveCount(2);

  // A genuinely new page instance: nothing in memory survives this.
  await page.goto("about:blank");
  await page.goto(opened.url);
  const cards = on(page).queuedAnnotation();
  await expect(cards, "the queue did not survive the reload").toHaveCount(2);
  await expect(cards.first()).toContainText(first);
  await expect(cards.last()).toContainText(second);

  // A restored card is still a card: Remove works, and is itself durable -
  // the removed item must not resurrect as a ghost on the next load.
  await on(cards.first()).removeQueued().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(1);
  await page.goto("about:blank");
  await page.goto(opened.url);
  await expect(on(page).queuedAnnotation(), "a removed item came back").toHaveCount(1);
  await expect(on(page).queuedAnnotation()).toContainText(second);

  // And a restored item still DRIVES the POST it was written for: the note
  // reaches the agent and its anchor still resolves. Storage that renders a
  // card but cannot send it would pass everything above.
  await on(page).sendQueue().click();
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    opened.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string; annotations: { note: string; resolved: unknown }[] };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations).toHaveLength(1);
  expect(feedback.annotations[0]?.note).toBe(second);
  // Resolution is the proof the restored TARGET came through intact, not only
  // the note: a mangled anchor still POSTs fine and still renders a card.
  expect(feedback.annotations[0]?.resolved).toBeTruthy();
});
