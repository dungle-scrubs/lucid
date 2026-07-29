import { chord, hook, on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLAN_V1,
  makeCli,
  openIntoHub,
  startHub,
  surfaceOf,
  type Cli,
  type Hub,
  waitTimeoutSeconds,
} from "./helpers.ts";

/**
 * The shell (Model B): one daemon window over every session. These tests run
 * a real `lucid hub` on an ephemeral port with an isolated registry, `lucid
 * open` sessions into it, and drive the tab bar.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
let cli2: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  await cli2?.cleanup();
  cli = cli2 = undefined;
  await hub?.stop();
  hub = undefined;
});

test("lucid open surfaces the session as a tab in the shell", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  // The ?s= tab opens itself once the listing names it.
  await expect(on(page).shellTab()).toHaveCount(1);
  // A tab is named by the DOCUMENT, not the file: the fixture's <title> is
  // "Migration plan", which is what a reader recognizes.
  await expect(on(page).shellTab()).toContainText("Migration plan");
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
});

test("the review loop works through the daemon mount", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  const surface = surfaceOf(page);
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("One batch, please.");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // The agent's wait sees the annotation appended by the daemon-hosted mount.
  const feedback = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(8)])) as {
    status: string;
    annotations: { note: string }[];
  };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations.some((a) => a.note.includes("One batch"))).toBe(true);
});

test("each sent item shows where it got to: recorded, then delivered (D20)", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // The cursor an agent would be holding BEFORE the message exists. A wait
  // with no `--since` is a catch-up read and deliberately does not ack, so
  // this leaves the message undelivered when it lands.
  const before = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(1)])) as {
    nextCursor: string;
  };

  await page.locator(`${hook("message-input")}:visible`).fill("does anyone see this?");
  await page.locator(`${hook("send-message")}:visible`).click();

  const state = on(page).deliveryState();
  await expect(state).toHaveCount(1);
  await expect(state).toHaveAttribute("data-state", "recorded");

  // A cursor-bearing wait takes delivery and acks it - and the panel says so
  // on the item itself, which is the whole point: nobody has to ask.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    before.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string };
  expect(feedback.status).toBe("feedback");
  await expect(state).toHaveAttribute("data-state", "delivered");
});

test("an empty shell can point itself at a folder and find the sessions in it", async ({
  page,
}) => {
  // The cold start: a hub scanning nowhere useful. The session exists on disk
  // already - it was opened by a CLI with its OWN registry, so no pointer in
  // the hub's registry and no scan root covers it. This is the "my past
  // reviews are invisible and there is nothing on screen to do about it" case.
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  await cli.run(["open", cli.artifact]);

  await page.goto(`http://127.0.0.1:${hub.port}/`);
  await expect(on(page).pickerProject()).toHaveCount(0);
  // It says where it looked, which is what makes the miss correctable.
  await expect(page.locator("code", { hasText: hub.dir })).toBeVisible();

  // Paste the folder rather than opening the native chooser - the same route a
  // human needs for a scratchpad path Finder will not show them.
  await on(page).addFolderType().first().click();
  await on(page).addFolderPath().first().fill(cli.dir);
  await on(page).addFolderPathAdd().first().click();

  // The listing IS the confirmation, and it arrives over the stream - no
  // reload, no restart. (Not asserted on the status line: success replaces
  // this whole screen with the populated one, which unmounts it.)
  await expect(on(page).pickerProject()).toHaveCount(1);
  await expect(on(page).pickerRow().first()).toContainText("Migration plan");
});

test("the new-tab screen offers only artifacts that are NOT already open", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  // A second artifact in the same folder, so the project holds two.
  const second = join(cli.dir, "rollout.html");
  await writeFile(second, PLAN_V1.replace("Migration plan", "Rollout checklist"));
  await cli.run(["open", second]);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // "+" is a place to OPEN something. The one artifact already sitting in the
  // strip is not an option - picking it would just switch to that tab.
  await on(page).tabAdd().click();
  const rows = on(page).pickerRow();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Rollout checklist");

  // Open it too, and the screen says so rather than claiming there is nothing.
  await rows.first().click();
  await expect(on(page).shellTab()).toHaveCount(2);
  await on(page).tabAdd().click();
  await expect(on(page).allOpen()).toBeVisible();
  await expect(on(page).pickerRow()).toHaveCount(0);
});

test("the new-artifact dialog validates the name and names the flag it needs", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  await on(page).tabAdd().click();
  await on(page).newArtifact().click();
  await expect(on(page).createDialog()).toBeVisible();

  // Live validation, because the hub joins the name onto a project root it
  // already knows: a path is never a filename.
  await on(page).createName().fill("../escape.html");
  await expect(on(page).createNameError()).toBeVisible();
  await on(page).createName().fill("rollout.html");
  await expect(on(page).createNameError()).toHaveCount(0);

  // This hub runs WITHOUT --attend, so it spawns nothing. The dialog says so
  // up front - and submitting anyway reaches the hub's 403 and reports the
  // same command rather than a status code.
  await on(page).createPrompt().fill("a rollout plan for billing");
  await expect(on(page).createAttendHint()).toContainText("lucid hub --attend");
  await on(page).createSubmit().click();
  await expect(on(page).createError()).toContainText("lucid hub --attend");
  // Refused, not started: no authoring state, and nothing was created.
  await expect(on(page).createAuthoring()).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(on(page).createOverlay()).toHaveCount(0);
});

test("the command palette opens sessions and runs review actions", async ({ page }) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const second = await openIntoHub(
    hub,
    PLAN_V1.replace("Database migration plan", "Rollout checklist"),
  );
  cli2 = second.cli;

  await page.goto(first.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  const cmdK = process.platform === "darwin" ? chord("k") : "Control+k";

  // ⌘K -> the unified list (M4.1): the one OPENABLE session (the other is
  // already a tab) opens as a NEW tab beside it - the strip shows every open
  // tab now (M2.1), so a cross-project open adds, never replaces.
  await page.keyboard.press(cmdK);
  await expect(on(page).paletteInput()).toBeFocused();
  const openableInPalette = on(page).palette().locator(hook("picker-row"));
  await expect(openableInPalette).toHaveCount(1);
  await openableInPalette.click();
  await expect(on(page).paletteOverlay()).toHaveCount(0);
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(surfaceOf(page).locator("h1")).toContainText("Rollout checklist");

  // ⌘K -> "toggle marks" runs an action on the ACTIVE session.
  await page.keyboard.press(cmdK);
  await on(page).paletteInput().fill("toggle");
  await page.keyboard.press("Enter");
  await expect(on(page).paletteOverlay()).toHaveCount(0);

  // Escape closes a reopened palette without running anything.
  await page.keyboard.press(cmdK);
  await expect(on(page).paletteInput()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(on(page).paletteOverlay()).toHaveCount(0);
});

test("⌘W closes the artifact in front of you; the closed tab is still openable", async ({
  page,
}) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  // A SECOND artifact, so the strip shows two and ⌘W has something to close.
  const other = join(first.cli.dir, "rollout.html");
  await writeFile(
    other,
    PLAN_V1.replace("<title>Migration plan</title>", "<title>Rollout checklist</title>"),
    "utf8",
  );
  await first.cli.run(["open", other]);

  await page.goto(first.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row"), { hasText: "Rollout checklist" }).click();
  await expect(on(page).shellTab()).toHaveCount(2);

  // ⌘W closes the ACTIVE tab only. The browser owns the real ⌘W in a normal
  // tab, so this asserts the shell's own handling of the gesture.
  await page.keyboard.press(chord("w"));
  await expect(on(page).shellTab()).toHaveCount(1);
  // The session it closed is still listed by the hub - a closed tab is not a
  // deleted artifact, so the pick screen offers it again.
  await on(page).tabAdd().click();
  await expect(on(page).pickerRow()).toHaveCount(1);
});

test("a dropped hub reports itself ONCE, at the composer", async ({ page }) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  await page.goto(first.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await expect(on(page).reconnecting()).toHaveCount(0);

  // Kill the hub's listing stream by stopping the hub itself. Exactly one
  // indicator may appear: two, in two corners, described one drop twice.
  await hub.stop();
  const indicator = on(page).reconnecting();
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toBeVisible();
});

test("add-folder is reachable from the populated pick screen and the palette (M2.4, D-007)", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  // A second, unopened artifact keeps the pick screen in its POPULATED state
  // (rows to offer) - the state that used to lack the add-folder control.
  const other = join(cli.dir, "rollout.html");
  await writeFile(
    other,
    PLAN_V1.replace("<title>Migration plan</title>", "<title>Rollout checklist</title>"),
    "utf8",
  );
  await cli.run(["open", other]);
  await cli.run(["end", other]);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await expect(on(page).pickerRow()).toHaveCount(1); // populated, not empty
  await expect(on(page).addFolder()).toBeVisible(); // ...and correctable anyway

  // The palette carries the same affordance as a command.
  await page.keyboard.press(chord("k"));
  await expect(on(page).paletteInput()).toBeFocused();
  await expect(on(page).paletteAddFolder()).toBeVisible();
});

test("the create dialog defaults to the most recently used root (M2.4, D-005)", async ({
  page,
}) => {
  hub = await startHub();
  // TWO projects, so the default is a real choice: with nothing remembered the
  // dialog must ask, and with a remembered root it must pick THAT one - the
  // sole-candidate shortcut cannot fake either answer.
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const second = await openIntoHub(
    hub,
    PLAN_V1.replace("<title>Migration plan</title>", "<title>Other plan</title>"),
  );
  cli2 = second.cli;

  await page.goto(first.shellUrl);
  // One TAB, but two LISTED projects - the dialog's roots come from the
  // listing, so the default is a genuine two-way choice.
  await expect(on(page).shellTab()).toHaveCount(1);

  // Nothing remembered + two candidates: the field asks instead of guessing.
  await on(page).tabAdd().click();
  await on(page).newArtifact().click();
  await expect(on(page).createDialog()).toBeVisible();
  const projectTrigger = on(page).createProject();
  const secondName = cli2.dir.split("/").pop() ?? "";
  await expect(projectTrigger).not.toContainText(secondName);
  await page.keyboard.press("Escape");

  // Remembered root: the next dialog opens on it.
  await page.evaluate((root) => localStorage.setItem("lucid.createRoot", root), cli2.dir);
  await on(page).newArtifact().click();
  await expect(on(page).createDialog()).toBeVisible();
  await expect(on(page).createProject()).toContainText(secondName);
});
