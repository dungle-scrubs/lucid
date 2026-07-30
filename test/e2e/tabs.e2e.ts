import { chord, hook, on } from "./locators.ts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  makeCli,
  openIntoHub,
  PLAN_V1,
  startHub,
  surfaceOf,
  waitTimeoutSeconds,
  type Cli,
  type Hub,
} from "./helpers.ts";

/**
 * The tab strip's lifecycle: how a session becomes a tab (`?s=` at boot), and
 * what closing one does to the session behind it.
 *
 * Every test here drives a real `lucid hub` with an isolated registry, exactly
 * as `shell.e2e.ts` does - the shell's tab logic only exists over a live
 * listing stream, and a fixture without one cannot exhibit any of it.
 */

let hub: Hub | undefined;
const clis: Cli[] = [];

/** The hub's own id for an artifact: `sha256(canonicalArtifactPath).slice(0,16)`
 *  (src/server/daemon.ts:95). A COPY, not an import, and not by preference:
 *  `daemon.ts` transitively imports `sessions.ts`, whose `import { Glob } from
 *  "bun"` cannot load under Playwright's Node runtime - the whole suite died
 *  at startup when this tried to be an import. `canonicalArtifactPath` is
 *  `resolve()` and nothing else - no realpath - so the path the harness holds
 *  IS the path hashed; if the product ever realpaths its identity, this test
 *  goes red here, which is the honest place. */
const sessionIdOf = (artifactPath: string): string =>
  createHash("sha256").update(artifactPath).digest("hex").slice(0, 16);

test.afterEach(async () => {
  // Independent processes, reaped concurrently: each cleanup is its own
  // spawned `end` plus an rm, and nothing here orders them.
  await Promise.all(clis.map((c) => c.cleanup()));
  clis.length = 0;
  await hub?.stop();
  hub = undefined;
});

/** PLAN_V1 under its own title (and optionally heading) - the same vocabulary
 *  tabs-focus.e2e.ts uses. Rewriting the file on disk is also how these tests
 *  force the hub to publish a NEW listing snapshot: the daemon's title cache
 *  is keyed by mtime, so the picker row's text changing is proof a fresh
 *  snapshot reached the shell. */
const planNamed = (title: string, heading?: string): string => {
  const titled = PLAN_V1.replace("<title>Migration plan</title>", `<title>${title}</title>`);
  return heading ? titled.replace("Database migration plan", heading) : titled;
};

const tabNamed = (page: Page, name: string): Locator =>
  page.locator(hook("shell-tab"), { hasText: name });

const activeTab = (page: Page): Locator => page.locator(`${hook("shell-tab")}[data-active="true"]`);

test("?s= for a session the listing does not name yet is retried, not dropped", async ({
  page,
}) => {
  hub = await startHub();
  // A session that exists on disk and that this hub cannot see: it was opened
  // by a CLI with its own registry, and the hub scans only its own dir. That
  // is the identity miss the boot handler has to survive - the same shape as
  // a `lucid open` whose registry write has not reached the listing yet.
  const cli = await makeCli(PLAN_V1);
  clis.push(cli);
  await cli.run(["open", cli.artifact]);

  await page.goto(`${hub.url}?s=${sessionIdOf(cli.artifact)}`);
  // Settled on the pick screen: the empty state only renders once the first
  // listing snapshot has landed (`loaded`), and it names where it looked - so
  // this is a snapshot that did NOT contain the wanted id, not a page that has
  // yet to hear from the hub.
  await expect(page.locator("code", { hasText: hub.dir })).toBeVisible();
  await expect(on(page).pickerProject()).toHaveCount(0);
  await expect(on(page).shellTab()).toHaveCount(0);

  // Point the hub at the folder that holds it. Nothing here opens a tab - it
  // adds a scan root, so the next snapshot names the id.
  //
  // Through the API rather than the UI: adding a root from the browser is a
  // native folder chooser now (the paste-a-path field is gone), and a test
  // cannot drive one. What this test is about is what happens AFTER a root
  // lands - the pending tab opening itself - so the route that puts it there is
  // incidental, and the endpoint is the same one the chooser posts to.
  // `hub.url` already ends in a slash - joining another one 404s.
  const added = await page.request.post(`http://127.0.0.1:${hub.port}/hub/roots`, {
    data: { path: cli.dir },
  });
  expect(added.ok(), await added.text()).toBe(true);

  // The tab opens ITSELF. The id was still pending from boot, so the snapshot
  // that finally names it is honored - no second navigation, no click on a row.
  await expect(on(page).shellTab()).toHaveCount(1);
  await expect(on(page).shellTab()).toContainText("Migration plan");
});

test("a closed boot tab does not resurrect on the next listing snapshot", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  clis.push(opened.cli);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // Closed by hand: the human has now owned the tab set, and the id in the URL
  // has had its one use.
  await on(page).tabClose().click();
  await expect(on(page).shellTab()).toHaveCount(0);
  const row = on(page).pickerRow();
  await expect(row).toHaveCount(1);

  // Two fresh snapshots, each one an opportunity for the boot id to re-fire.
  //
  // A tab count of zero is an ABSENCE, so it needs a settle signal that holds
  // in both worlds - otherwise it resolves against a page that has simply not
  // heard from the hub yet. The new title is that signal: it reaches a shell
  // that stayed on the pick screen as row text, and a shell that resurrected
  // the tab as the TAB's own label (a tab is named by the listing row that
  // opened it), so waiting for either proves the snapshot was processed
  // whichever way the shell handled it. The second rewrite then puts a whole
  // listing poll between the first opportunity to re-fire and the last read.
  const labelled = row.or(on(page).shellTab());
  await opened.cli.write(planNamed("Migration plan (second look)"));
  await expect(labelled).toContainText("second look");
  await expect(on(page).shellTab()).toHaveCount(0);
  await opened.cli.write(planNamed("Migration plan (third look)"));
  await expect(labelled).toContainText("third look");

  await expect(on(page).shellTab()).toHaveCount(0);
});

test("closing a tab with × leaves the session alive and re-openable", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  const cli = opened.cli;
  clis.push(cli);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabClose().click();
  await expect(on(page).shellTab()).toHaveCount(0);

  // The agent's side of the session is untouched: `wait` still answers, and it
  // answers as a running session rather than an ended one. An ended session
  // reports `ended`; a session whose server went away reports `suspended`.
  const answer = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(2)])) as {
    status: string;
  };
  expect(["waiting", "feedback"]).toContain(answer.status);

  // And the human's side: "+" offers the artifact back, because a closed tab
  // is not a deleted session.
  await on(page).tabAdd().click();
  const rows = on(page).pickerRow();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Migration plan");
  await expect(on(page).allOpen()).toHaveCount(0);
});

test("closing the active tab promotes a neighbour that is still live", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  const cli = opened.cli;
  clis.push(cli);
  // Two more artifacts in the SAME folder, so one project holds three sessions
  // and the strip shows all three under one scope.
  const rollout = join(cli.dir, "rollout.html");
  const runbook = join(cli.dir, "runbook.html");
  await writeFile(rollout, planNamed("Rollout checklist"), "utf8");
  await writeFile(runbook, planNamed("Runbook"), "utf8");

  await page.goto(opened.shellUrl);
  const tabs = on(page).shellTab();
  await expect(tabs).toHaveCount(1);
  // Opened while the window is up, so each `lucid open` surfaces its own tab -
  // the strip fills in the order the CLI ran.
  await cli.run(["open", rollout]);
  await expect(tabs).toHaveCount(2);
  await cli.run(["open", runbook]);
  await expect(tabs).toHaveCount(3);

  // Visit each in turn, so every tab has actually been activated and holds a
  // live stream - a tab nobody ever looked at would prove nothing about a
  // promoted one.
  for (const label of ["Migration plan", "Rollout checklist", "Runbook"]) {
    await tabNamed(page, label).click();
    await expect(activeTab(page)).toContainText(label);
  }

  // The middle one is in front, and ⌘W closes it.
  await tabNamed(page, "Rollout checklist").click();
  await expect(activeTab(page)).toContainText("Rollout checklist");
  await page.keyboard.press(chord("w"));
  await expect(tabs).toHaveCount(2);

  // A neighbour took its place - which one is the shell's business, so read it
  // rather than assume it.
  const active = activeTab(page);
  await expect(active).toHaveCount(1);
  const neighbours: ReadonlyArray<readonly [string, string]> = [
    ["Migration plan", cli.artifact],
    ["Runbook", runbook],
  ];
  let promoted: readonly [string, string] | undefined;
  for (const candidate of neighbours) {
    if ((await active.filter({ hasText: candidate[0] }).count()) > 0) promoted = candidate;
  }
  // One of the two neighbours, and only a neighbour. A throw rather than an
  // `expect`, so the rest of the test has a session to reply to without a cast
  // - and so the message names whatever IS in front instead of "undefined".
  if (!promoted) {
    throw new Error(`the tab in front is neither neighbour: ${await active.innerText()}`);
  }

  // The promotion has to be a LIVE view, not a still of one: an agent reply
  // appended to that session must reach the thread on screen with no click and
  // no reload.
  await cli.run([
    "wait",
    promoted[1],
    "--reply",
    "promoted neighbour check",
    "--timeout",
    waitTimeoutSeconds(2),
  ]);
  await expect(page.locator('[data-role="agent"]:visible')).toContainText(
    "promoted neighbour check",
  );
});

test("⌘W over an unsent queue: reopening the artifact restores the queued note", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  clis.push(opened.cli);
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // A note written and queued, never sent - the only copy of the human's words.
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill("do not lose this note");
  await on(page).addToQueue().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(1);

  await page.keyboard.press(chord("w"));
  await expect(on(page).shellTab()).toHaveCount(0);

  // Reopening from the picker restores the queue from the session's own
  // storage (D-054): the close destroyed a view, not the words. This is the
  // scenario's survivable arm - the alternative (a gated close) was declined
  // when the queue became durable, because a guard dialog protects nothing
  // that persistence has not already protected better.
  await on(page).pickerRow().click();
  await expect(on(page).shellTab()).toHaveCount(1);
  const restored = on(page).queuedAnnotation();
  await expect(restored, "the queued note did not survive the close").toHaveCount(1);
  await expect(restored).toContainText("do not lose this note");
});

test("closing the only tab lands on the pick screen offering it again", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  clis.push(opened.cli);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  await page.keyboard.press(chord("w"));
  await expect(on(page).shellTab()).toHaveCount(0);

  // The pick screen, offering the artifact just closed. Not "every session is
  // already open" - that would be a window claiming to hold a tab it does not
  // have - and not a blank pane either.
  const rows = on(page).pickerRow();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Migration plan");
  await expect(on(page).allOpen()).toHaveCount(0);
});
