import { hook, on } from "./locators.ts";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { PLAN_V1, makeCli, type Cli, waitTimeoutSeconds } from "./helpers.ts";

/**
 * Modifier picks (stage 2 of multi-spot feedback): cmd-click collects several
 * spots into ONE annotation draft, shift-click pins a spot straight onto the
 * open question's answer, and shift+cmd collects several pins. All against the
 * real overlay in the sandboxed iframe - the modifiers ride the click event
 * across the origin boundary.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]');

const openViewer = async (page: Page): Promise<{ nextCursor: string }> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return { nextCursor: session.nextCursor };
};

test("cmd-click collects two spots into one annotation that reaches wait as targets[2]", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // First cmd-click starts the collection; the second adds to it instead of
  // replacing the pick the way a plain click would.
  await surface.locator('li[data-lucid-id="step-backfill"]').click({ modifiers: ["Meta"] });
  await expect(on(page).annotationNote()).toBeVisible();
  await surface.locator("#note").click({ modifiers: ["Meta"] });

  // ONE draft, two chips - and two pending marks on the surface.
  await expect(on(page).targetChip()).toHaveCount(2);
  await expect(surface.locator(".marker.pending")).toHaveCount(2);

  await page
    .locator(hook("annotation-note"))
    .fill("These two must agree: batch the backfill AND drop the zero-downtime claim.");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();

  // One annotation card carrying both snippets (not two annotations).
  await expect(on(page).annotation()).toHaveCount(1);

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    annotations: {
      note: string;
      target: { snippet: string };
      targets?: { snippet: string }[];
    }[];
  };
  expect(fb.annotations).toHaveLength(1);
  const a = fb.annotations[0];
  expect(a?.note).toContain("These two must agree");
  expect(a?.targets).toHaveLength(2);
  // The wire's first-element rule: target IS targets[0].
  expect(a?.target.snippet).toBe(a?.targets?.[0]?.snippet);
  expect(a?.targets?.[0]?.snippet).toContain("Backfill");
  expect(a?.targets?.[1]?.snippet).toContain("zero downtime");
});

test("cmd-click is a toggle: repeating a pick removes its spot", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click({ modifiers: ["Meta"] });
  await surface.locator("#note").click({ modifiers: ["Meta"] });
  await expect(on(page).targetChip()).toHaveCount(2);

  // Cmd-click the same element again: its spot leaves the collection.
  await surface.locator("#note").click({ modifiers: ["Meta"] });
  // Down to one spot, the draft is the ordinary single-target composer again.
  await expect(on(page).targetChip()).toHaveCount(0);
  await expect(on(page).annotationNote()).toBeVisible();
  await expect(surface.locator(".marker.pending")).toHaveCount(1);

  // Escape discards the whole collection as one gesture. Wait for the second
  // spot to land first: the pick crosses the frame boundary as a postMessage,
  // and an instant Escape could otherwise beat it into the chrome.
  await surface.locator("#note").click({ modifiers: ["Meta"] });
  await expect(on(page).targetChip()).toHaveCount(2);
  await on(page).annotationNote().press("Escape");
  await expect(on(page).annotationNote()).toHaveCount(0);
  await expect(surface.locator(".marker.pending")).toHaveCount(0);
});

test("shift-click pins the spot straight onto the open question's answer", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  await cli.run(["ask", cli.artifact, "--text", "Which step is riskiest?"]);
  await expect(on(page).questionDrawer()).toBeVisible();

  // No "Pin a spot" click first - shift-click IS the pin gesture.
  await surface.locator('li[data-lucid-id="step-backfill"]').click({ modifiers: ["Shift"] });
  await expect(on(page).answerAnchor()).toBeVisible();
  // And no annotation composer opened: the pick went to the answer.
  await expect(on(page).annotationNote()).toHaveCount(0);

  await on(page).freeText().fill("The backfill.");
  await on(page).answer().click();
  await expect(on(page).questionDrawer()).toHaveCount(0);

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    questions?: { answered: boolean; answerAnchor?: { snippet: string } }[];
  };
  expect(fb.questions?.[0]?.answered).toBe(true);
  expect(fb.questions?.[0]?.answerAnchor?.snippet).toContain("Backfill");
});

test("shift+cmd-click collects several answer pins that reach wait as anchors[2]", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  await cli.run(["ask", cli.artifact, "--text", "Which parts does your answer refer to?"]);
  await expect(on(page).questionDrawer()).toBeVisible();

  await surface
    .locator('li[data-lucid-id="step-backfill"]')
    .click({ modifiers: ["Shift", "Meta"] });
  await surface.locator("#note").click({ modifiers: ["Shift", "Meta"] });
  await expect(on(page).answerAnchor()).toHaveCount(2);

  // A chip's × drops that pin alone; re-pin it for the send.
  await page
    .locator(`${hook("answer-anchor")} button`)
    .nth(1)
    .click();
  await expect(on(page).answerAnchor()).toHaveCount(1);
  await surface.locator("#note").click({ modifiers: ["Shift", "Meta"] });
  await expect(on(page).answerAnchor()).toHaveCount(2);

  await on(page).freeText().fill("Both of these.");
  await on(page).answer().click();
  await expect(on(page).questionDrawer()).toHaveCount(0);

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    questions?: {
      answered: boolean;
      answerAnchor?: { snippet: string };
      answerAnchors?: { snippet: string }[];
    }[];
  };
  const q = fb.questions?.[0];
  expect(q?.answered).toBe(true);
  expect(q?.answerAnchors).toHaveLength(2);
  // The wire's first-element rule: answerAnchor IS answerAnchors[0].
  expect(q?.answerAnchor?.snippet).toBe(q?.answerAnchors?.[0]?.snippet);
  expect(q?.answerAnchors?.[0]?.snippet).toContain("Backfill");
  expect(q?.answerAnchors?.[1]?.snippet).toContain("zero downtime");
});

test("shift-click with no open question falls back to a plain pick", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  // No question outstanding: shift must never be a dead gesture.
  await surface.locator('li[data-lucid-id="step-backfill"]').click({ modifiers: ["Shift"] });
  await expect(on(page).annotationNote()).toBeVisible();
  await expect(on(page).answerAnchor()).toHaveCount(0);
});

test("a leftover selection does not ride a stationary shift-click as the pin", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  await cli.run(["ask", cli.artifact, "--text", "Which step is riskiest?"]);
  await expect(on(page).questionDrawer()).toBeVisible();

  // Leave a selection lying around, the way real reading does. Set it
  // programmatically: a locator selectText fires its own mouseup and would
  // post a pick of its own before the gesture under test.
  const frame = page.frames().find((f) => /127\.0\.0\.1:\d+\/$/.test(f.url()));
  await frame?.evaluate(() => {
    const p = document.getElementById("note");
    if (!p?.firstChild) throw new Error("note not found");
    const range = document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, 20);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  // A stationary shift-click elsewhere would natively EXTEND that selection;
  // the pin must be the clicked ELEMENT, not the accidental range.
  await surface.locator('li[data-lucid-id="step-backfill"]').click({ modifiers: ["Shift"] });
  await expect(on(page).answerAnchor()).toBeVisible();

  await on(page).freeText().fill("The backfill.");
  await on(page).answer().click();

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    questions?: { answerAnchor?: { kind: string; snippet: string } }[];
  };
  expect(fb.questions?.[0]?.answerAnchor?.kind).toBe("element");
  expect(fb.questions?.[0]?.answerAnchor?.snippet).toContain("Backfill");
  expect(fb.questions?.[0]?.answerAnchor?.snippet).not.toContain("downtime");
});
