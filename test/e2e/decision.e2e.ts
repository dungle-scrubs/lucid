import { hook, on } from "./locators.ts";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { makeCli, type Cli, waitTimeoutSeconds } from "./helpers.ts";

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]');

const openViewer = async (page: Page, html: string): Promise<void> => {
  cli = await makeCli(html);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Provider strategy");
};

/** What the agent reads back: one drain of everything pending. */
const feedback = async (): Promise<{
  annotations: { note: string; target: { lucidId?: string; snippet: string } }[];
}> =>
  (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    "evt_00001",
    "--timeout",
    waitTimeoutSeconds(1),
  ])) as { annotations: { note: string; target: { lucidId?: string; snippet: string } }[] };

/**
 * Decision points: an element the agent marks for confirm-or-refuse.
 *
 * The two rules the human asked for are both about NESTING - a recommendation
 * contains other pickable things, and you cannot see where it starts:
 *
 * 1. Everything inside a marked element offers the options too.
 * 2. Choosing one answers the DECISION, not the child that was picked.
 *
 * A typed note still annotates exactly what was picked, which is why picking
 * something inside is worth doing at all.
 */

const DECIDE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Recommendation</title></head>
<body><article>
  <h1>Provider strategy</h1>
  <p id="plain">Background on the current clients.</p>
  <li id="rec" data-lucid-id="rec-1" data-lucid-decision>
    Adopt <code id="inner">Prism</code> over per-provider clients.
  </li>
</article></body></html>`;

test("a marked element offers Agree/Decline, and so does everything inside it", async ({
  page,
}) => {
  await openViewer(page, DECIDE);
  const surface = surfaceOf(page);

  // Unmarked prose: the generic asks only.
  await surface.locator("#plain").click();
  await expect(on(page).quickReply().first()).toBeVisible();
  await expect(page.locator(hook("decision-reply"))).toHaveCount(0);

  // The marked element itself.
  await surface.locator("#rec").click();
  await expect(page.locator(hook("decision-reply"))).toHaveCount(2);
  await expect(page.locator('[data-reply="Agree"]')).toBeVisible();
  await expect(page.locator('[data-reply="Decline"]')).toBeVisible();
  // Beside the generic ones, not instead of them.
  await expect(on(page).quickReply().first()).toBeVisible();

  // RULE 1: a child of it, too - landing on the code span still decides.
  await page.keyboard.press("Escape");
  await surface.locator("#inner").click();
  await expect(page.locator(hook("decision-reply"))).toHaveCount(2);

  // RULE 2: choosing answers the DECISION, not the code span that was picked.
  await page.locator('[data-reply="Agree"]').click();
  await expect(on(page).queuedAnnotation()).toHaveCount(1);
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const fb = await feedback();
  expect(fb.annotations).toHaveLength(1);
  expect(fb.annotations[0]?.note).toBe("Agree");
  // The marked element's own id - not the <code> inside it.
  expect(fb.annotations[0]?.target.lucidId).toBe("rec-1");
});

test("the overlay draws where a decision starts and ends, so it can be aimed at", async ({
  page,
}) => {
  // The human's own objection: "I could see it being difficult to land on the
  // right target, or I don't know where the target starts." Nothing on the
  // page distinguished a decision from prose, so its boundary was invisible.
  await openViewer(page, DECIDE);
  // Playwright pierces the overlay's shadow root, the way the other overlay
  // specs reach markers.
  const decisionMark = surfaceOf(page).locator(".marker.decision");
  await expect(decisionMark).toHaveCount(1);

  // At rest - before any pick. It is the ground the review marks sit on.
  await expect(page.locator(hook("decision-reply"))).toHaveCount(0);

  // And it covers the marked element, not the code span inside it.
  const markBox = await decisionMark.boundingBox();
  const recBox = await surfaceOf(page).locator("#rec").boundingBox();
  expect(markBox).not.toBeNull();
  expect(recBox).not.toBeNull();
  expect(Math.abs((markBox?.width ?? 0) - (recBox?.width ?? 0))).toBeLessThan(3);
});

test("a typed note still annotates exactly what was picked", async ({ page }) => {
  await openViewer(page, DECIDE);
  const surface = surfaceOf(page);

  // Picking inside and typing is a comment about the INSIDE - only the two
  // decision chips retarget, because only they answer the decision.
  await surface.locator("#inner").click();
  await on(page).annotationNote().fill("is this the current version?");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const fb = await feedback();
  expect(fb.annotations[0]?.note).toBe("is this the current version?");
  expect(fb.annotations[0]?.target.lucidId).toBeUndefined();
  expect(fb.annotations[0]?.target.snippet).toContain("Prism");
});
