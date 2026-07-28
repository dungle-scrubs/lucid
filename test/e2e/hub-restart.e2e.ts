import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fixedHubPort,
  killHubOnPort,
  openIntoHub,
  PLAN_V1,
  startHub,
  surfaceOf,
  type Cli,
  type Hub,
} from "./helpers.ts";
import { hook, on } from "./locators.ts";

/**
 * The hub comes back on the port it left (M6.2, K).
 *
 * A restart is the ordinary event here, not the exotic one: `lucid app` after a
 * crash, a rebuild, a machine waking up. Every open window keeps its tabs, its
 * drafts and its scroll position across it - or it does not, and then the
 * failure is silent and total, because a window stuck on "reconnecting…" looks
 * exactly like a window that is fine until you try to send something.
 *
 * A FIXED port is what makes any of this reachable. On an ephemeral port a
 * restarted hub is a different hub as far as the browser is concerned, so the
 * whole recovery path - the stale-descriptor branch in `handleSessionRoute`,
 * the client's own reopen of a stream the spec calls fatal - was code no test
 * could enter.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
/** Kept across the restart, so it is this file's to remove. */
let keptState: string | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
  // A fixed-port hub is invisible to the global teardown's survivor sweep:
  // `survivingProcesses` recognizes `lucid-e2e-` paths and `--port 0`, and a
  // `hub --port 17538` carries neither (its temp dir rides in env, not argv).
  // If this file's runner dies between startHub and stop(), nothing else will
  // ever reap it, and the NEXT run's startHub({port}) dies with "hub exited
  // early" for a cause that lives in a previous session. So this file sweeps
  // its own port, both ways - after each test, and before the first bind.
  await killHubOnPort(fixedHubPort());
  if (keptState !== undefined) {
    await rm(keptState, { recursive: true, force: true });
    keptState = undefined;
  }
});

test.beforeEach(async () => {
  await killHubOnPort(fixedHubPort());
});

test("a hub restarted on the same port re-adopts open windows without a reload", async ({
  page,
}) => {
  const port = fixedHubPort();
  // 1s rather than the production 15s ceiling: this test is about whether the
  // tab comes back at all, and the client's exponential backoff would
  // otherwise put the answer up to 15s away (D-015 seam).
  hub = await startHub({ port, sseMaxBackoffMs: 1000 });
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // A second session in the SAME project, so both tabs sit in one scope and
  // the strip shows two. It arrives by the open-tab broadcast, which also
  // proves the window is connected before anything is killed.
  const second = join(cli.dir, "rollout.html");
  await writeFile(
    second,
    PLAN_V1.replace("<title>Migration plan</title>", "<title>Rollout checklist</title>"),
  );
  await cli.run(["open", second]);
  await expect(on(page).shellTab()).toHaveCount(2);

  // Drafts in the tab in front: an annotation note (session store) and an
  // unsent message (assistant-ui component state). Both die on a page reload,
  // which is precisely the claim - the window must recover WITHOUT one.
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator(`${hook("annotation-note")}:visible`).fill("one batch, please");
  await page.locator(`${hook("message-input")}:visible`).fill("does this survive the hub dying?");

  // Down, and OBSERVED to be down. Without this the restart could complete
  // before the window ever noticed, and "the indicator cleared on its own"
  // would be a statement about an indicator that never appeared.
  await hub.stop({ keepState: true });
  keptState = hub.dir;
  // `:visible`, because every open tab's view stays mounted and each carries
  // its own connection line - two tabs means two pills in the DOM and one on
  // screen, which is the one a human is looking at.
  const pill = page.locator(`${hook("reconnecting")}:visible`);
  await expect(pill).toHaveCount(1);

  // Same port, same registry: the same hub as far as every open window knows.
  hub = await startHub({ port, dir: keptState, sseMaxBackoffMs: 1000 });
  keptState = undefined; // the new hub owns the dir again

  // It clears itself. Nobody reloaded, nobody clicked anything.
  await expect(pill).toHaveCount(0);
  // Both tabs, and exactly both: a re-adoption that re-opened what was already
  // open would show four.
  await expect(on(page).shellTab()).toHaveCount(2);
  // The drafts are still there, which is the same fact as "this page was never
  // reloaded" said in the terms a human would notice it in.
  await expect(page.locator(`${hook("annotation-note")}:visible`)).toHaveValue("one batch, please");
  await expect(page.locator(`${hook("message-input")}:visible`)).toHaveValue(
    "does this survive the hub dying?",
  );

  // And the stream is not merely open, it is CARRYING: an event appended by the
  // agent after the restart lands in the tab that is already on screen. Asked
  // about `second`, which is the session in front - a question for a background
  // tab is deliberately not raised (tabs-focus), so it would prove nothing
  // about the stream this window is watching.
  await cli.run(["ask", second, "--text", "Which store are we cutting over to?"]);
  await expect(on(page).questionDrawer()).toBeVisible();
  await expect(on(page).questionText()).toContainText("cutting over");
});
