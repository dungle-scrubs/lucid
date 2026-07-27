import { on } from "./locators.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness.ts";
import { delayRoute } from "./routes.ts";
import { surfaceOf, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * The queue and composer under a wire that misbehaves (M5.1, route-intercept).
 *
 * Every test interferes with a request on its way to the server - delayed,
 * aborted, or answered with a verdict - and asserts the product's side of the
 * bargain: nothing a human wrote is swept away, frozen state is visibly
 * frozen, and every failure says what happened. The `cli` fixture supplies
 * the session; `page.route` supplies the weather.
 */

const openViewer = async (page: Page, cli: Cli): Promise<{ cursor: string }> => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return { cursor: session.nextCursor };
};

/** Pick an element, write the note, queue it - no send. */
const queueNote = async (page: Page, selector: string, note: string): Promise<void> => {
  await surfaceOf(page).locator(selector).click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(note);
  await on(page).addToQueue().click();
};

test("a partial batch drops exactly the items that landed", async ({ page, cli }) => {
  // The second POST fails on a 500, which the transport treats as a blip and
  // retries through its full 14s backoff schedule before giving up - the
  // product answering slowly IS the scenario.
  test.slow();
  // An uncaught exception here is not a detail: this scenario found one that
  // unmounted the entire viewer to a blank page. Fail on the throw itself,
  // not only on its symptoms, so the next regression names its own cause.
  const crashes: string[] = [];
  page.on("pageerror", (e) => crashes.push(e.message));
  await openViewer(page, cli);

  const notes = [
    "Backfill in one batch, not nightly.",
    "Name the rollback owner for this step.",
    "Which downtime window does the cutover assume?",
  ] as const;
  await queueNote(page, 'li[data-lucid-id="step-backfill"]', notes[0]);
  await queueNote(page, "#steps li:nth-child(3)", notes[1]);
  await queueNote(page, "#note", notes[2]);
  await expect(on(page).queuedAnnotation()).toHaveCount(3);

  // First annotation POST lands; every later one is refused by the server.
  let annotationPosts = 0;
  await page.route("**/__lucid/annotation", (route) => {
    annotationPosts += 1;
    if (annotationPosts === 1) return route.continue();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the log went away mid-batch" }),
    });
  });

  await on(page).sendQueue().click();

  // The warning is the settle signal: it is written after the catch, after
  // the reconcile decided what to keep. Exactly ONE warning - a failure per
  // remaining card would be three claims about one event.
  await expect(on(page).warning()).toContainText("kept in the queue", { timeout: 30_000 });
  await expect(on(page).warning()).toHaveCount(1);

  // Exactly what landed left the queue; exactly what did not stayed.
  await expect(on(page).annotation()).toHaveCount(1);
  await expect(on(page).annotation()).toContainText(notes[0]);
  const kept = on(page).queuedAnnotation();
  await expect(kept).toHaveCount(2);
  await expect(kept.first()).toContainText(notes[1]);
  await expect(kept.last()).toContainText(notes[2]);

  // The viewer is still a viewer. `sendQueue` posts each item under its own
  // id, so a landed annotation and its still-queued card shared one id until
  // this batch was fixed - two timeline entries with one id, and
  // assistant-ui's MessageRepository takes the whole tree down with it.
  expect(crashes, `the viewer threw: ${crashes.join(" | ")}`).toEqual([]);
  await expect(on(page).sendQueue()).toBeVisible();
});

test("a note queued while a send is in flight is not swept away by it", async ({ page, cli }) => {
  await openViewer(page, cli);

  await delayRoute(page, "**/__lucid/annotation", 2000);
  await queueNote(page, 'li[data-lucid-id="step-backfill"]', "A: the one that is sending");
  await on(page).sendQueue().click();

  // Mid-flight: the human keeps working. B enters the queue while A's POST
  // is held by the route.
  await queueNote(page, "#note", "B: queued during A's flight");

  // When the send settles, A is a sent card - and B was reconciled against
  // LIVE state, not a pre-send snapshot, so it is still queued, note intact.
  await expect(on(page).annotation()).toHaveCount(1, { timeout: 15_000 });
  await expect(on(page).annotation()).toContainText("A: the one that is sending");
  await expect(on(page).queuedAnnotation()).toHaveCount(1);
  await expect(on(page).queuedAnnotation()).toContainText("B: queued during A's flight");
});

test("the composer is frozen while a fork POST is in flight, and cannot double-fork", async ({
  page,
  cli,
}) => {
  const { cursor } = await openViewer(page, cli);

  await delayRoute(page, "**/__lucid/fork", 3000);
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Spin the backfill into its own plan.");
  await on(page).fork().click();

  // Inside the flight: the note is uneditable, the button says what it is
  // doing, and a second click has nothing to press.
  await expect(on(page).annotationNote()).toBeDisabled();
  await expect(on(page).fork()).toContainText("Forking…");
  await expect(on(page).fork()).toBeDisabled();

  // After the flight: exactly ONE fork reached the log. The double-click
  // this guards against would mint a second fork id the dedupe cannot
  // collapse, so the count is the whole point.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    cursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string; forks?: { note: string }[] };
  expect(feedback.status).toBe("feedback");
  expect(feedback.forks?.length).toBe(1);
});

test("an image that cannot upload says so instead of vanishing", async ({ page, cli }) => {
  await openViewer(page, cli);

  await page.route("**/__lucid/asset", (route) => route.abort("connectionfailed"));
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).annotationNote()).toBeVisible();

  // A real paste, as the browser delivers one: a file on the clipboard data.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    const el = document.querySelector('[data-test="annotation-note"]');
    el?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });

  // The warning is the settle signal for the absence beside it: once the
  // failure is on screen, a chip that was going to appear would exist.
  await expect(on(page).warning()).toContainText("That image didn't upload - try again.");
  await expect(on(page).annotationChip()).toHaveCount(0);
});

test("queue cards cannot be edited or removed mid-send, and the bar is down", async ({
  page,
  cli,
}) => {
  await openViewer(page, cli);

  await queueNote(page, 'li[data-lucid-id="step-backfill"]', "first of two");
  await queueNote(page, "#note", "second of two");
  await delayRoute(page, "**/__lucid/annotation", 3000);
  await on(page).sendQueue().click();

  // Inside the flight, every control that could change what is being sent is
  // frozen: an item edited mid-flight would send its old note while showing
  // its new one.
  await expect(on(page).editQueued().first()).toBeDisabled();
  await expect(on(page).removeQueued().first()).toBeDisabled();
  await expect(on(page).sendQueue()).toBeDisabled();

  // After the send the controls are gone WITH the cards - a control outliving
  // its card would be a button wired to nothing.
  await expect(on(page).queuedAnnotation()).toHaveCount(0, { timeout: 15_000 });
  await expect(on(page).editQueued()).toHaveCount(0);
  await expect(on(page).sendQueue()).toHaveCount(0);
  await expect(on(page).annotation()).toHaveCount(2);
});
