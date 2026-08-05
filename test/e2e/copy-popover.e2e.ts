import { expect, test, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { on } from "./locators.ts";
import { PLAN_V1, makeCli, type Cli } from "./helpers.ts";

/**
 * The Copy Popover: the sole copy affordance for artifact text (D-001, D-002).
 *
 * A drag-select in the opaque-origin artifact posts a `selection-copy`
 * (text + release point) to the parent chrome; the chrome anchors a Popover at
 * the translated release point and writes the clipboard on a Copy click. It is
 * mode-independent - copying is a read action - so the suite covers BOTH
 * targeting modes. Clipboard assertions need the async clipboard API, so the
 * context grants `clipboard-read`/`clipboard-write` (the real `--app` writes
 * on a user gesture in a secure context; Playwright's Chromium needs the grant
 * explicitly - spike A-002).
 */

test.use({ contextOptions: { permissions: ["clipboard-read", "clipboard-write"] } });

const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]');

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

/** The artifact's frame, matched the way the loop suite matches it (on the
 *  session server's root URL) rather than reaching through `frameLocator`. */
const artifactFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => /127\.0\.0\.1:\d+\/$/.test(f.url()));
  if (!frame) throw new Error("artifact iframe not found");
  return frame;
};

/** Select `phrase` inside the note paragraph and fire a mouseup carrying the
 *  release coords, mirroring the loop suite's range-selection idiom: the
 *  overlay's capture-phase mouseup reads the selection and posts
 *  `selection-copy`. */
const selectPhraseInArtifact = async (
  page: Page,
  phrase: string,
  releaseAt: { x: number; y: number } = { x: 40, y: 40 },
): Promise<void> => {
  await artifactFrame(page).evaluate(
    ({ p, coords }) => {
      const el = document.getElementById("note");
      if (!el?.firstChild) throw new Error("note paragraph not found");
      const text = el.firstChild as Text;
      const content = text.textContent ?? "";
      const start = content.indexOf(p);
      if (start < 0) throw new Error(`phrase "${p}" not found in note paragraph`);
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + p.length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      // Carry clientX/Y so the Popover anchors at a real release point; the
      // overlay's onMouseUp reads these for the selection-copy payload.
      document.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, clientX: coords.x, clientY: coords.y }),
      );
    },
    { p: phrase, coords: releaseAt },
  );
};

/** Clear the clipboard so a later read is not a stale value from a prior test. */
const clearClipboard = (page: Page): Promise<unknown> =>
  page.evaluate(() => navigator.clipboard.writeText("").catch(() => {}));

/** Read the clipboard, retrying briefly: the async clipboard read resolves on
 *  its own microtask, so a single read can race the click settling. */
const readClipboard = async (page: Page): Promise<string> => {
  const deadline = Date.now() + 2_000;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.evaluate(() => navigator.clipboard.readText());
    if (last.length > 0) return last;
    await page.waitForTimeout(25);
  }
  return last;
};

test("targeting ON: drag-select shows the Copy Popover and Copy writes the selection", async ({
  page,
}) => {
  await openViewer(page);
  await clearClipboard(page);

  await selectPhraseInArtifact(page, "zero downtime");
  const popover = on(page).copyPopover();
  await expect(popover).toBeVisible();

  await on(page).copyPopoverCopy().click();
  expect(await readClipboard(page)).toBe("zero downtime");

  // A copy closes the Popover.
  await expect(popover).toHaveCount(0);
});

test("targeting OFF (read mode): drag-select still shows the Copy Popover and copies", async ({
  page,
}) => {
  await openViewer(page);
  await clearClipboard(page);

  // Enter read mode: toggling the crosshair off. Copy is mode-independent.
  await on(page).toggleTargets().click();
  await expect(on(page).toggleTargets()).toHaveAttribute("aria-pressed", "false");

  await selectPhraseInArtifact(page, "zero downtime");
  await expect(on(page).copyPopover()).toBeVisible();
  await on(page).copyPopoverCopy().click();
  expect(await readClipboard(page)).toBe("zero downtime");
});

test("the Popover dismisses on scroll", async ({ page }) => {
  await openViewer(page);
  await selectPhraseInArtifact(page, "zero downtime");
  const popover = on(page).copyPopover();
  await expect(popover).toBeVisible();

  // The dismissal wiring is a NON-capture window scroll listener: only a
  // genuine viewport/document scroll - the one that moves the iframe, and
  // with it the anchor - dismisses. Inner-element scrolls (the review panel,
  // the thread viewport) do not bubble and must NOT dismiss; the real-drag
  // test below pins that side. Dispatching on window is exactly what a real
  // document scroll delivers to the listener.
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await expect(popover).toHaveCount(0);
});

test("a new selection re-anchors (replaces), never stacks two Popovers", async ({ page }) => {
  await openViewer(page);
  await clearClipboard(page);

  // First selection.
  await selectPhraseInArtifact(page, "zero downtime");
  await expect(on(page).copyPopover()).toHaveCount(1);

  // A second, different selection replaces the open Popover rather than opening
  // a second one alongside it.
  await selectPhraseInArtifact(page, "downtime");
  await expect(on(page).copyPopover()).toHaveCount(1);

  // Copy writes the SECOND selection, proving the replace carried the new text.
  await on(page).copyPopoverCopy().click();
  expect(await readClipboard(page)).toBe("downtime");
});

test("a REAL drag-select keeps the Popover open, above the release point, without stealing focus", async ({
  page,
}) => {
  // The synthetic-mouseup cases above hid a live bug: a real drag in targeting
  // mode ALSO sets pendingTarget, the annotation composer autofocuses
  // (Panel.tsx), and the focus() scrolls the review panel column into view.
  // The old capture-phase scroll listener caught that INNER scroll and closed
  // the Popover the frame it opened. The short viewport is load-bearing: it
  // makes the panel column overflow so the composer focus really scrolls it,
  // reproducing the live condition a fresh full-height viewer never hits.
  await page.setViewportSize({ width: 1280, height: 420 });
  await openViewer(page);
  await clearClipboard(page);

  // The phrase's rect inside the iframe viewport, then a REAL mouse drag
  // (mousedown -> mousemove -> mouseup) across it in parent coordinates.
  const rect = await artifactFrame(page).evaluate((phrase) => {
    const el = document.getElementById("note");
    if (!el?.firstChild) throw new Error("note paragraph not found");
    const text = el.firstChild as Text;
    const start = (text.textContent ?? "").indexOf(phrase);
    if (start < 0) throw new Error(`phrase "${phrase}" not found`);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + phrase.length);
    const r = range.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, "zero downtime");
  const frameBox = await page.locator('iframe[title="artifact surface"]').boundingBox();
  if (!frameBox) throw new Error("iframe has no bounding box");
  const y = frameBox.y + (rect.top + rect.bottom) / 2;
  await page.mouse.move(frameBox.x + rect.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + rect.right - 1, y, { steps: 12 });
  await page.mouse.up();

  const popover = on(page).copyPopover();
  await expect(popover).toBeVisible();

  // The guard's precondition, asserted so it cannot silently evaporate: the
  // panel column must actually overflow at this viewport, or the composer
  // focus scrolls nothing and this test stops testing the dismissal.
  await expect
    .poll(() =>
      on(page)
        .threadViewport()
        .evaluate((el) => el.scrollHeight > el.clientHeight),
    )
    .toBe(true);

  // STAYS visible: the composer's focus-scroll of the panel column must not
  // dismiss a Popover whose anchor never moved (the bug lived here - it
  // survived one frame).
  await page.waitForTimeout(500);
  await expect(popover).toBeVisible();

  // Above the release point (Medium-style), not below it.
  const popoverBox = await popover.boundingBox();
  if (!popoverBox) throw new Error("popover has no bounding box");
  expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(y);

  // The Popover never steals the keyboard: the same drag opened the
  // annotation composer, and its autofocus must win (initialFocus={false}).
  await expect(on(page).annotationNote()).toBeFocused();

  // And Copy still works from the surviving Popover.
  await on(page).copyPopoverCopy().click();
  expect(await readClipboard(page)).toBe("zero downtime");
  await expect(popover).toHaveCount(0);
});

test("a bare click (no selection) does not open the Popover", async ({ page }) => {
  await openViewer(page);
  // A click with a collapsed selection: the overlay's decision returns false,
  // so no selection-copy is posted and no Popover opens.
  await artifactFrame(page).evaluate(
    (coords) => {
      const sel = window.getSelection();
      sel?.removeAllRanges(); // collapsed: nothing selected
      document.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, clientX: coords.x, clientY: coords.y }),
      );
    },
    { x: 40, y: 40 },
  );
  await expect(on(page).copyPopover()).toHaveCount(0);
});
