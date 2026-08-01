import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { makeCli, PLAN_V1, surfaceOf, type Cli } from "../helpers.ts";
import { sessionPaths } from "../../../src/core/paths.ts";

/**
 * Regression: the surface took one 404 as permanent.
 *
 * A session is created a beat before its first version is committed. A viewer
 * that asked for the artifact inside that window got the stand-in document -
 * and then sat on it forever, because nothing reloads that frame: it is
 * sandboxed onto an opaque origin, so the chrome's live-swap has no overlay to
 * talk to and no way in. The human saw "the file may have been moved or
 * deleted" about a file that was about to exist, and only a manual reload
 * cleared it.
 *
 * Staged with the artifact itself removed, so nothing can restore the served
 * copy behind the test's back; writing the artifact again is what a first
 * commit does from the surface's point of view.
 */

let cli: Cli;
test.afterEach(async () => {
  await cli?.cleanup();
});

test("the surface comes back on its own once the artifact exists", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  const paths = sessionPaths(cli.artifact);

  // Nothing to serve, and nothing on disk to rebuild it from.
  await rm(paths.currentHtml, { force: true });
  await rm(paths.artifactPath, { force: true });
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("body")).toContainText("artifact file is missing");

  // The artifact returns; the frame must find that out by itself.
  await cli.write(PLAN_V1);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan", {
    timeout: 20_000,
  });
});
