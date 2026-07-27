import { on } from "./locators.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness.ts";
import { overlaySettled, surfaceOf, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * The annotation QUEUE: the staging area between a pick and the agent.
 *
 * Everything here is about work that has been written but not yet delivered,
 * which is the only state in the product where the human's words exist in
 * exactly one place. So each test drives a real failure - a server that is not
 * answering, a response that never came back - and then proves both halves:
 * nothing was eaten, and the retry did not duplicate.
 */

// The `cli` fixture (harness.ts) replaces the module-level `let cli` +
// afterEach pattern: `use()` teardown runs whether a test passes, fails or
// throws, per test rather than per file (D-022).

const openViewer = async (page: Page, cli: Cli): Promise<{ url: string; nextCursor: string }> => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return session;
};

/** Take delivery since `cursor` and hand back the feedback payload - the
 *  five-argument wait incantation, spelled once instead of four times. */
const feedbackSince = async <T extends { status: string }>(
  cli: Cli,
  cursor: string,
): Promise<T> => {
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    cursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as T;
  expect(fb.status).toBe("feedback");
  return fb;
};

/** Pick an element in the artifact, write a note, and queue it. */
const queueNote = async (page: Page, selector: string, note: string): Promise<void> => {
  await surfaceOf(page).locator(selector).click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(note);
  await on(page).addToQueue().click();
};

/**
 * Bring the session's server back on the address the tab is already sitting on.
 *
 * `sessionPortPool` prefers a fixed per-session port, so a reopened session
 * lands back on the URL the browser has - that is the product's own claim, and
 * asserting the origin here is what keeps the reconnect below from silently
 * becoming "the page never came back". The indicator clearing is the reconnect
 * signal on the SAME page: a reload would throw away the in-memory queue and
 * draft, which is exactly what these tests exist to protect.
 */
const reopenOnSameOrigin = async (page: Page, cli: Cli): Promise<void> => {
  const reopened = (await cli.run(["open", cli.artifact])) as { url: string };
  expect(
    new URL(reopened.url).origin,
    "the reopened session did not rebind the port the tab is on",
  ).toBe(new URL(page.url()).origin);
  await expect(on(page).reconnecting()).toHaveCount(0, { timeout: 20_000 });
};

test("a dead server keeps every queued annotation, and the retry sends each one once", async ({
  page,
  cli,
}) => {
  // Two failed-POST rounds of backoff plus a reconnect: the product answering
  // slowly is the scenario, not a tuning problem.
  test.slow();
  const session = await openViewer(page, cli);

  // THREE, on three different elements. One cannot prove "every item is kept":
  // a catch path that keeps only the item it died on would pass with a single
  // card, and each note needs its own element so the delivered set can be
  // matched one-to-one rather than counted.
  const notes = [
    "Backfill in one batch, not nightly.",
    "Name the rollback for this step.",
    "Say which downtime window this assumes.",
  ] as const;
  await queueNote(page, 'li[data-lucid-id="step-backfill"]', notes[0]);
  await queueNote(page, "#steps li:nth-child(3)", notes[1]);
  await queueNote(page, "#note", notes[2]);
  await expect(on(page).queuedAnnotation()).toHaveCount(3);

  // The server goes out from under the viewer, mid-review.
  await cli.run(["end", cli.artifact]);
  await expect(on(page).reconnecting()).toBeVisible();

  await on(page).sendQueue().click();
  // The warning is the settle signal for everything below: it is written at the
  // END of the failed send, after the catch and before the queue is reconciled,
  // so a card count read after it is a count of what the send decided to keep -
  // not the value that happened to be there while the POST was still retrying.
  await expect(
    on(page).warning(),
    "a failed send must say the annotations are still queued",
  ).toContainText("kept in the queue", { timeout: 30_000 });
  await expect(on(page).queuedAnnotation()).toHaveCount(3);
  await expect(on(page).annotation()).toHaveCount(0);

  await reopenOnSameOrigin(page, cli);

  await on(page).sendQueue().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(0, { timeout: 20_000 });
  await expect(on(page).annotation()).toHaveCount(3);

  // The cursor was taken BEFORE anything was written, so this is the whole
  // record of the review: three annotations, one per note, and no second copy
  // of the ones the first attempt tried to send.
  const fb = await feedbackSince<{ status: string; annotations: { note: string }[] }>(
    cli,
    session.nextCursor,
  );
  expect(fb.annotations.map((a) => a.note).sort()).toEqual([...notes].sort());
});

test("a queued card takes the NEXT number, on its card and on its mark alike", async ({
  page,
  cli,
}) => {
  await openViewer(page, cli);

  // One annotation SENT: card 1, mark 1.
  await queueNote(page, 'li[data-lucid-id="step-backfill"]', "Nightly is fine for the backfill.");
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // A second QUEUED on a different element: it takes the NEXT number in both
  // places. The panel and the surface must agree - a queued mark wearing "1"
  // beside a sent mark wearing "1" is two claims to the same badge, and the
  // card saying "2" over a mark saying "1" is worse: the human cannot tell
  // which mark their unsent note is about.
  await queueNote(page, "#note", "Which downtime window does this assume?");
  const queued = on(page).queuedAnnotation();
  await expect(queued).toHaveCount(1);
  await expect(queued).toHaveAttribute("aria-label", "Queued annotation 2");

  // The overlay repaints on the queue push; settled() is what makes reading
  // both badges a statement about the final frame.
  await overlaySettled(page);
  await expect(surfaceOf(page).locator(".badge")).toHaveText(["1", "2"]);
});

test("sending with an editor open sends the EDITED note, not the one it replaced", async ({
  page,
  cli,
}) => {
  const session = await openViewer(page, cli);

  await queueNote(page, 'li[data-lucid-id="step-backfill"]', "first draft");
  await on(page).editQueued().click();
  await expect(on(page).editNote()).toBeVisible();
  await on(page).editNote().fill("batched, not nightly");

  // No Save. The open editor is the whole point: the human typed the correction
  // and reached straight for Send, which is what a person does.
  await on(page).sendQueue().click();

  await expect(on(page).annotation()).toHaveCount(1);
  await expect(on(page).annotation()).toContainText("batched, not nightly");
  await expect(on(page).annotation()).not.toContainText("first draft");

  const fb = await feedbackSince<{ status: string; annotations: { note: string }[] }>(
    cli,
    session.nextCursor,
  );
  expect(fb.annotations.map((a) => a.note)).toEqual(["batched, not nightly"]);
});

test("a wall of text pasted into an annotation folds, and the agent still gets every line", async ({
  page,
  cli,
}) => {
  const session = await openViewer(page, cli);

  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().click();

  // Forty lines of terminal output, delivered the way the browser delivers a
  // paste. The existing paste test covers the MESSAGE composer; this is the
  // annotation composer, which is a different textarea and a different send.
  const wall = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join("\n");
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const el = document.querySelector('[data-test="annotation-note"]') as HTMLTextAreaElement;
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, wall);

  // The note box holds the placeholder, not the wall, and typing continues
  // after it as if the paste were one token.
  await expect(on(page).annotationNote()).toHaveValue("[Pasted text #1 +40 lines]");
  await on(page).annotationNote().pressSequentially(" - why did this fail?");
  await on(page).addToQueue().click();

  // The queued card shows what the human wrote, placeholder and all.
  await expect(on(page).queuedAnnotation()).toContainText("[Pasted text #1 +40 lines]");
  await expect(on(page).queuedAnnotation()).not.toContainText("log line 39");

  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // The agent reads what was actually pasted - every line of it - not the
  // placeholder that stood in for it on screen.
  const fb = await feedbackSince<{ status: string; annotations: { note: string }[] }>(
    cli,
    session.nextCursor,
  );
  const note = fb.annotations[0]?.note ?? "";
  expect(note).not.toContain("Pasted text #1");
  expect(note).toContain("log line 0");
  expect(note).toContain("log line 39 - why did this fail?");
  expect(note.split("\n")).toHaveLength(40);
});

test("a failed fork keeps the draft, and a manual retry produces exactly one fork", async ({
  page,
  cli,
}) => {
  // Two full POST-retry ladders (a dead server, then a lost response) before
  // the fork that lands.
  test.slow();
  const session = await openViewer(page, cli);

  const directive = "Spin the backfill step out into its own migration plan.";
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(directive);

  // --- the outage: the server is simply gone -------------------------------
  await cli.run(["end", cli.artifact]);
  await expect(on(page).reconnecting()).toBeVisible();
  await on(page).fork().click();
  await expect(on(page).warning(), "a failed fork must say the draft is kept").toContainText(
    "the draft is kept",
    { timeout: 30_000 },
  );
  // The button latches for the whole POST and is released by the SAME catch
  // that keeps the draft, so waiting on the release is what makes the two
  // assertions below read the state the failure settled on rather than the
  // state that happened to be there while the request was still retrying.
  await expect(on(page).fork()).toBeEnabled();
  await expect(on(page).annotationNote()).toHaveValue(directive);
  await expect(surfaceOf(page).locator(".marker.pending")).toHaveCount(1);

  await reopenOnSameOrigin(page, cli);

  // --- the ambiguous failure: the server TOOK it, the answer never came ----
  //
  // This is the failure the stable fork id exists for, and the only one that
  // can exhibit the dedupe: a fork that never reached the server has nothing to
  // dedupe against, so a test that only kills the server would pass just as
  // happily with a fresh id minted per click. `fetch` performs the real request
  // - the server appends the fork - and `abort` throws away the response, which
  // is what the tab would see if the socket died on the way back.
  await page.route("**/__lucid/fork", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await on(page).fork().click();
  // NOT the warning copy: the first failure's warning is still on screen, so
  // asserting that text again resolves instantly against the old one and would
  // let this click be examined while its POST is still in flight. The latch is
  // this attempt's own signal - down while the request runs, released by its
  // catch - and it cannot be satisfied by anything the first failure left.
  await expect(on(page).fork()).toBeDisabled();
  await expect(on(page).fork()).toBeEnabled({ timeout: 30_000 });
  await expect(on(page).annotationNote()).toHaveValue(directive);

  // --- the manual retry ----------------------------------------------------
  await page.unroute("**/__lucid/fork");
  await on(page).fork().click();
  await expect(on(page).notice()).toContainText("Fork", { timeout: 20_000 });
  // The draft is spent, which is the positive effect that says this click was
  // the one that landed.
  await expect(on(page).annotationNote()).toHaveCount(0);

  const fb = await feedbackSince<{ status: string; forks?: { note: string }[] }>(
    cli,
    session.nextCursor,
  );
  expect(
    fb.forks?.map((f) => f.note),
    "the retry reused the fork id, so the log holds one fork - not a twin",
  ).toEqual([directive]);
});
