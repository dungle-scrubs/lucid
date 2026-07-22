import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, type Cli } from "./helpers.ts";

/**
 * The thread viewport is a vertical record: wide content scrolls inside its
 * own container (fenced code, tables) and prose wraps, so the viewport itself
 * must never grow a horizontal scrollbar - at any panel width.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]');

const PARA =
  "Does it do too much: no, and the deletion test says why. Delete planner and its complexity does not vanish - it reappears at every plan as hand-run stages with no ledger, no drift check, no resume.";

/** Every markdown shape that is wide by nature: a fenced one-liner command,
 *  a table, a long unbroken token, and a long inline code path. */
const WIDE_REPLY = [
  PARA,
  "",
  "```",
  'lucid wait <file> --since <cursor> --timeout 120 --harness claude-code --resume "claude --resume 01890c2e-aaaa-bbbb-cccc-ddddeeeeffff --dangerously-skip-permissions"',
  "```",
  "",
  "| mode | owner | consumer | notes |",
  "| --- | --- | --- | --- |",
  "| DECOMPOSE | planner | to-tickets | keeps deciding the slices, publishing stays external |",
  "| CONSOLIDATE | planner | to-domain-docs | follows as its consumer after the retarget lands |",
  "",
  "A long inline path `skills/engineering/prepare-public-release/references/distribution-setup-and-oidc-trusted-publishing.md` sits mid-sentence, and an unbroken token XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX ends it.",
  "",
  PARA,
].join("\n");

for (const width of [384, 950]) {
  test(`thread viewport never scrolls horizontally (panel at ${width}px)`, async ({ page }) => {
    cli = await makeCli(PLAN_V1);
    const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
    await page.addInitScript((w) => localStorage.setItem("lucid:chromeWidth", String(w)), width);
    await page.goto(session.url);
    const surface = surfaceOf(page);
    await expect(surface.locator("h1")).toContainText("Database migration plan");

    await cli.run([
      "wait",
      cli.artifact,
      "--reply",
      WIDE_REPLY,
      "--since",
      session.nextCursor,
      "--timeout",
      "1",
    ]);

    // A located annotation and a human message round out the record's shapes.
    await surface.locator('li[data-lucid-id="step-backfill"]').click();
    await page
      .locator('textarea[placeholder^="What should change here?"]')
      .fill("can remove it entirely from AGENTS.md. when i want to make a skill, i will do so.");
    await page.locator('[data-test="add-to-queue"]').click();
    await page.locator('[data-test="send-queue"]').click();
    await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

    const box = await page.evaluate(() => {
      const vp = document.querySelector('[data-test="thread-viewport"]');
      if (!vp) return null;
      return {
        scrollWidth: vp.scrollWidth,
        clientWidth: vp.clientWidth,
        overflowX: getComputedStyle(vp).overflowX,
      };
    });
    expect(box).not.toBeNull();
    // The content genuinely fits (wide things scroll internally or wrap)...
    expect(box?.scrollWidth).toBeLessThanOrEqual(box?.clientWidth ?? 0);
    // ...and even if a future regression overflowed, the viewport clips
    // rather than growing a horizontal scrollbar.
    expect(box?.overflowX).toBe("hidden");
  });
}
