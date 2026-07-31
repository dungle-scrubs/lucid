import { on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import {
  abortRoute,
  type Cli,
  delayRoute,
  delaySocketFrames,
  killSessionServer,
  makeCli,
  openIntoHub,
  PLAN_V1,
  startHub,
  stubRoute,
  surfaceOf,
} from "./helpers.ts";

/**
 * The capabilities themselves, under test.
 *
 * M5.1 and M5.2 will assert product behaviour THROUGH these helpers - what the
 * composer does when a POST is aborted, what the shell shows when a server is
 * killed. Those tests can only be trusted if the helper does what its name
 * says, and a helper that silently no-ops would make every one of them pass by
 * doing nothing at all. So each one is exercised here against the real shell,
 * once, before anything is built on top of it.
 */

let cli: Cli | undefined;
test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

test("abortRoute really stops the request reaching the server", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };

  const attempted: string[] = [];
  page.on("requestfailed", (request) => attempted.push(request.url()));
  await abortRoute(page, "**/__lucid/state*");

  await page.goto(opened.url);
  await expect(surfaceOf(page).locator("h1")).toBeVisible();
  // The page still loads - only the intercepted call dies - and the failure is
  // observable, which is what M5.1's scenarios will hang their assertions on.
  await expect
    .poll(() => attempted.filter((url) => url.includes("/__lucid/state")).length)
    .toBeGreaterThan(0);
});

test("stubRoute really substitutes the response body", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };

  await stubRoute(page, "**/__lucid/state*", {
    status: 503,
    body: JSON.stringify({ error: "stubbed by the harness" }),
  });

  const seen: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/__lucid/state")) seen.push(response.status());
  });

  await page.goto(opened.url);
  await expect(surfaceOf(page).locator("h1")).toBeVisible();
  // 503 is not a status this server ever returns, so seeing it proves the stub
  // answered rather than the real route.
  await expect.poll(() => seen).toContain(503);
});

test("delayRoute really holds the request up", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };

  const HELD_MS = 1500;
  let elapsed = 0;
  page.on("requestfinished", (request) => {
    if (!request.url().includes("/__lucid/state")) return;
    const timing = request.timing();
    if (timing.responseEnd > 0) elapsed = Math.max(elapsed, timing.responseEnd);
  });
  await delayRoute(page, "**/__lucid/state*", HELD_MS);

  await page.goto(opened.url);
  await expect(surfaceOf(page).locator("h1")).toBeVisible();
  // Loosely, because the assertion is "the delay happened", not "the delay was
  // exactly 1500ms" - a timing budget would be a flake generator on CI.
  await expect.poll(() => elapsed, { timeout: 15_000 }).toBeGreaterThan(HELD_MS * 0.8);
});

test("delaySocketFrames really holds the live channel's frames up", async ({ page }) => {
  // A hub, because the socket this helper exists for is the shell's listing
  // stream - `makeCli` alone has no such channel to hold.
  const hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  try {
    const HELD_MS = 1500;
    await delaySocketFrames(page, "**/hub/events", HELD_MS);

    // Measured through the SHELL, not through `page.on("websocket")`: under
    // `routeWebSocket` that event reports Playwright's own connection to the
    // server, which sees every frame on time. The held frames are the ones the
    // page gets, so the page is where the hold is observable at all.
    const startedAt = Date.now();
    await page.goto(hub.url);

    // Connected, nothing said yet. Without the hold the listing has already
    // landed by here - measured: this assertion is what caught the helper being
    // inert when the wire changed.
    await expect(page.getByText("Looking for sessions…")).toBeVisible();
    await expect(on(page).pickerRow()).toHaveCount(0);

    // ...and the frames DO arrive. A helper that held them forever would pass
    // every assertion above while breaking each test built on it.
    await expect(on(page).pickerRow()).toHaveCount(1, { timeout: 20_000 });
    // Loosely, because the assertion is "the delay happened", not "the delay
    // was exactly 1500ms" - a timing budget would be a flake generator.
    expect(Date.now() - startedAt).toBeGreaterThan(HELD_MS * 0.8);
  } finally {
    await hub.stop();
  }
});

test("killSessionServer refuses a session whose server is already gone", async () => {
  // The safety property, end to end this time: `end` stops the server but
  // leaves the session on disk, so the descriptor is exactly the stale-pid case
  // the helper must not fire on. Its unit tests inject the kill; this one uses
  // the real `process.kill` and relies on the refusal happening first.
  cli = await makeCli(PLAN_V1);
  await cli.run(["open", cli.artifact]);
  await cli.run(["end", cli.artifact]);

  await expect(killSessionServer(cli.artifact)).rejects.toThrow(
    /refusing to kill pid|nothing to kill/,
  );
});
