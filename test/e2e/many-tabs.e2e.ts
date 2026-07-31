import { hook, on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openIntoHub, PLAN_V1, startHub, surfaceOf, type Cli, type Hub } from "./helpers.ts";

/**
 * More open tabs than the browser will give the hub HTTP connections.
 *
 * The shell puts every session on ONE origin, and each open tab holds a live
 * stream. While those streams were SSE they came out of the browser's
 * six-connections-per-origin HTTP pool, alongside the shell's own listing
 * stream - so at five open tabs the pool was empty, and every fetch after that
 * queued behind streams that never end. Sending an annotation failed with a
 * warning that told the human to try again, retrying could not work, and the
 * server had no record of any of it: the requests never left the browser.
 *
 * The streams are WebSockets now (client/chrome/stream.ts), which that pool
 * does not bound. This asserts the thing the human does - open a normal number
 * of tabs, then send feedback - because the defect was invisible at every
 * layer below it.
 */

let hub: Hub | undefined;
const clis: Cli[] = [];

test.afterEach(async () => {
  await Promise.all(clis.map((c) => c.cleanup()));
  clis.length = 0;
  await hub?.stop();
  hub = undefined;
});

/** One more tab than the old ceiling: six session streams plus the shell's own
 *  listing is seven connections, where the browser hands out six. */
const FILLERS = 5;

test("an annotation still sends with more open tabs than the connection pool holds", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  clis.push(opened.cli);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // Each `lucid open` reaches the live window over the hub's own stream and
  // surfaces as a tab - so this fills the strip the way a working day does,
  // and exercises the listing channel while it is at it.
  for (let i = 0; i < FILLERS; i++) {
    const filler = join(opened.cli.dir, `filler-${i}.html`);
    await writeFile(filler, `<!doctype html><title>Filler ${i}</title><h1>Filler ${i}</h1>`);
    await opened.cli.run(["open", filler]);
    await expect(on(page).shellTab()).toHaveCount(i + 2);
  }

  // Back to the plan, with every other tab still holding its stream. This is
  // the state in which sending used to be impossible.
  await page.locator(hook("shell-tab"), { hasText: "Migration plan" }).first().click();
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toContainText("Database migration plan");

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Nightly is fine for the backfill.");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();

  // The card is the proof the POST reached the log: it is rendered from the
  // folded state the server broadcasts back, not from the queue.
  await expect(on(page).annotation()).toHaveCount(1);
  await expect(on(page).annotation()).toContainText("Nightly is fine for the backfill.");

  // And the tabs that were holding streams are all still there - a send that
  // only worked because something had quietly evicted them would not be a fix.
  await expect(on(page).shellTab()).toHaveCount(FILLERS + 1);
});
