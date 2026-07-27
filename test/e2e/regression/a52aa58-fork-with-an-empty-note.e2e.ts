import type { Page } from "@playwright/test";
import type { Cli } from "../cli.ts";
import { surfaceOf } from "../visual.ts";
import { expect, test } from "../harness.ts";

/**
 * Regression: `a52aa58` - a fork with an empty note still sends.
 *
 * The region is the seed of a fork, so a directive is optional. Clicking Fork
 * with the note empty used to silently no-op: nothing left the viewer, nothing
 * said so, and the person went on believing they had forked.
 *
 * The revert does not apply on this tree, so the mutation is a named edit
 * instead (D-046): remove the default-directive fallback in
 * `client/chrome/store.ts` so an empty note sends an empty note.
 */

/** No module-level `let cli` and no afterEach: the `cli` fixture is created and
 *  cleaned up by `use()`, which runs whether this test passes, fails or throws
 *  (D-022). */
const openViewer = async (page: Page, cli: Cli): Promise<string> => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return session.nextCursor;
};

test("Fork with no directive still reaches the agent, and says it did", async ({ page, cli }) => {
  const nextCursor = await openViewer(page, cli);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toBeVisible();
  // No directive typed. The region alone is the instruction.
  await page.locator('[data-test="fork"]').click();

  // The person is told, on the notices channel - NOT `getByText(/Fork/)`, which
  // is satisfied by the button that was just clicked ("Forking…") and so
  // asserted nothing at all. Suppressing the notice used to leave this green.
  await expect(page.locator('[data-test="notice"]')).toContainText(/fork/i);

  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as { status: string; forks?: { note: string }[] };

  expect(feedback.forks, "no fork reached the agent").toHaveLength(1);
  expect(
    feedback.forks?.[0]?.note ?? "",
    "the fork arrived with an empty directive, so the agent was told nothing",
  ).not.toBe("");
});
