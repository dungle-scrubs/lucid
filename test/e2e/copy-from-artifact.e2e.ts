import { expect, test, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { on } from "./locators.ts";
import { PLAN_V1, makeCli, type Cli } from "./helpers.ts";

/**
 * Copying text out of the artifact while a chrome text field holds focus.
 *
 * The scenario the rest of the suite never touches: in the default targeting
 * mode, a target pick auto-focuses the composer note (a <textarea> in the
 * PARENT), which moves focus off the opaque-origin artifact iframe. The
 * artifact's text stays visually selected, but the focused document is now the
 * parent - so the browser's native copy targets the parent and copies nothing.
 * The capture-phase handler in Chrome.tsx refocuses the iframe before the
 * default copy action runs, restoring native copy without touching the composer
 * auto-focus policy.
 *
 * Clipboard assertions need the async clipboard API, so the file grants
 * `clipboard-read`/`clipboard-write` on its context. Chromium gates
 * `navigator.clipboard.readText` behind that permission; without it the read
 * rejects even though the copy itself succeeded.
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

/** The artifact's frame: matched the way the loop suite matches it, on the
 *  session server's root URL, rather than reaching through `frameLocator` for
 *  an in-frame `evaluate`. */
const artifactFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => /127\.0\.0\.1:\d+\/$/.test(f.url()));
  if (!frame) throw new Error("artifact iframe not found");
  return frame;
};

/**
 * Select `phrase` inside the artifact and fire mouseup, mirroring the loop
 * suite's range-selection idiom: the overlay's capture-phase mouseup reads the
 * selection and posts `target-picked`, which auto-focuses the composer note.
 * The selection persists in the iframe, which is the bug's precondition.
 */
const pickPhraseInArtifact = async (page: Page, phrase: string): Promise<void> => {
  await artifactFrame(page).evaluate((p) => {
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
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, phrase);
};

/** Read the clipboard, retrying briefly: native copy writes synchronously
 *  during the default action, but the async clipboard read resolves on its
 *  own microtask, so a single read can race the key press settling. */
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

test("Cmd+C copies the artifact's selection when the composer note holds focus", async ({
  page,
}) => {
  await openViewer(page);
  await page.evaluate(() => navigator.clipboard.writeText("").catch(() => {}));

  // Targeting mode is the default: picking text steals focus to the composer.
  await pickPhraseInArtifact(page, "zero downtime");
  const note = on(page).annotationNote();
  await expect(note).toBeVisible();
  // The bug's precondition: focus has left the artifact for the parent field.
  await expect(note).toBeFocused();

  // ⌘C while the note is focused. Without the handler this copies nothing
  // (the parent has no selection); with it, the iframe is refocused in the
  // capture phase and native copy reaches the artifact's selection.
  await page.keyboard.press("ControlOrMeta+c");

  expect(await readClipboard(page)).toBe("zero downtime");
});

test("Cmd+C copies the note's own selection, not the artifact's", async ({ page }) => {
  await openViewer(page);
  await page.evaluate(() => navigator.clipboard.writeText("").catch(() => {}));

  // A pick focuses the note, exactly as above.
  await pickPhraseInArtifact(page, "zero downtime");
  const note = on(page).annotationNote();
  await expect(note).toBeFocused();

  // The human types a note, then selects the text they just wrote to copy it.
  await note.fill("recheck the cutover window");
  await note.selectText();
  // The note now has its OWN selection. The handler must stand aside: a real
  // in-field copy is never redirected.
  await page.keyboard.press("ControlOrMeta+c");

  expect(await readClipboard(page)).toBe("recheck the cutover window");
});
