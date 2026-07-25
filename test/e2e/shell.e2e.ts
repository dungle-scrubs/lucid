import { expect, test } from "@playwright/test";
import { openIntoHub, PLAN_V1, startHub, surfaceOf, type Cli, type Hub } from "./helpers.ts";

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
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(page.locator('[data-test="shell-tab"]')).toContainText("plan.html");
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
});

test("the review loop works through the daemon mount", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  const surface = surfaceOf(page);
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator('textarea[placeholder^="What should change here?"]')
    .fill("One batch, please.");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  // The agent's wait sees the annotation appended by the daemon-hosted mount.
  const feedback = (await cli.run(["wait", cli.artifact, "--timeout", "8"])) as {
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
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);

  // The cursor an agent would be holding BEFORE the message exists. A wait
  // with no `--since` is a catch-up read and deliberately does not ack, so
  // this leaves the message undelivered when it lands.
  const before = (await cli.run(["wait", cli.artifact, "--timeout", "1"])) as {
    nextCursor: string;
  };

  await page.locator('[data-test="message-input"]:visible').fill("does anyone see this?");
  await page.locator('[data-test="send-message"]:visible').click();

  const state = page.locator('[data-test="delivery-state"]');
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
    "8",
  ])) as { status: string };
  expect(feedback.status).toBe("feedback");
  await expect(state).toHaveAttribute("data-state", "delivered");
});

test("the new-artifact dialog validates the name and names the flag it needs", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);

  await page.locator('[data-test="tab-add"]').click();
  await page.locator('[data-test="new-artifact"]').click();
  await expect(page.locator('[data-test="create-dialog"]')).toBeVisible();

  // Live validation, because the hub joins the name onto a project root it
  // already knows: a path is never a filename.
  await page.locator('[data-test="create-name"]').fill("../escape.html");
  await expect(page.locator('[data-test="create-name-error"]')).toBeVisible();
  await page.locator('[data-test="create-name"]').fill("rollout.html");
  await expect(page.locator('[data-test="create-name-error"]')).toHaveCount(0);

  // This hub runs WITHOUT --attend, so it spawns nothing. The dialog says so
  // up front - and submitting anyway reaches the hub's 403 and reports the
  // same command rather than a status code.
  await page.locator('[data-test="create-prompt"]').fill("a rollout plan for billing");
  await expect(page.locator('[data-test="create-attend-hint"]')).toContainText(
    "lucid hub --attend",
  );
  await page.locator('[data-test="create-submit"]').click();
  await expect(page.locator('[data-test="create-error"]')).toContainText("lucid hub --attend");
  // Refused, not started: no authoring state, and nothing was created.
  await expect(page.locator('[data-test="create-authoring"]')).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.locator('[data-test="create-overlay"]')).toHaveCount(0);
});

test("tabs scope to a project; the drawer switches; drafts survive", async ({ page }) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const second = await openIntoHub(
    hub,
    PLAN_V1.replace("Database migration plan", "Rollout checklist"),
  );
  cli2 = second.cli;

  await page.goto(first.shellUrl);
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  // The strip is project-scoped: the scope label names the boot session's project.
  await expect(page.locator('[data-test="scope-label"]')).toBeVisible();

  // "+" shows the pick screen SCOPED to this project; the second session
  // lives in another project, so widen to all projects first. The row must
  // be truly HITTABLE (elementFromPoint sees what a human sees - a clipped
  // popover once passed playwright's auto-scroll and failed a real pointer).
  await page.locator('[data-test="tab-add"]').click();
  await page.locator('[data-test="scope-clear"]').click();
  const row = page.locator('[data-test="picker-row"]').first();
  await expect(row).toBeVisible();
  const hittable = await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (el === hit || el.contains(hit));
  });
  expect(hittable).toBe(true);
  await page
    .locator('[data-test="picker-project"]', { hasText: second.cli.dir })
    .locator('[data-test="picker-row"]')
    .first()
    .click();

  // Opening it rescopes the strip to ITS project: one visible tab, the other
  // project's tab hidden, not gone.
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(surfaceOf(page).locator("h1")).toContainText("Rollout checklist");

  // Draft an annotation note AND a message here, then switch projects via
  // the drawer. Views stay mounted (display:none), so assertions use :visible.
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator('textarea[placeholder^="What should change here?"]:visible')
    .fill("only for the checklist");
  await page
    .locator('[data-test="message-input"]:visible')
    .fill("an unsent message must survive a project switch");

  await page.locator('[data-test="drawer-toggle"]').click();
  await expect(page.locator('[data-test="projects-drawer"]')).toBeVisible();
  await page.locator('[data-test="drawer-project"]', { hasText: cli.dir }).click();
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  await expect(
    page.locator('textarea[placeholder^="What should change here?"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator('[data-test="message-input"]:visible')).toHaveValue("");

  // Back via the drawer: BOTH drafts survived - the annotation note in the
  // session store, the message draft in assistant-ui component state, which
  // is exactly why hidden views stay mounted.
  await page.locator('[data-test="drawer-toggle"]').click();
  await page.locator('[data-test="drawer-project"]', { hasText: second.cli.dir }).click();
  await expect(
    page.locator('textarea[placeholder^="What should change here?"]:visible'),
  ).toHaveValue("only for the checklist");
  await expect(page.locator('[data-test="message-input"]:visible')).toHaveValue(
    "an unsent message must survive a project switch",
  );
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
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);

  const cmdK = process.platform === "darwin" ? "Meta+k" : "Control+k";

  // ⌘K -> fuzzy to the second session -> Enter opens it as a tab.
  await page.keyboard.press(cmdK);
  await expect(page.locator('[data-test="palette-input"]')).toBeFocused();
  await page.locator('[data-test="palette-input"]').fill("open plan");
  await page.locator('[data-test="palette"] [cmdk-item]', { hasText: "plan.html" }).first().click();
  await expect(page.locator('[data-test="palette-overlay"]')).toHaveCount(0);
  // Cross-project open rescopes the strip: one visible tab in the new project.
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(surfaceOf(page).locator("h1")).toContainText("Rollout checklist");

  // ⌘K -> "toggle marks" runs an action on the ACTIVE session.
  await page.keyboard.press(cmdK);
  await page.locator('[data-test="palette-input"]').fill("toggle");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-test="palette-overlay"]')).toHaveCount(0);

  // Escape closes a reopened palette without running anything.
  await page.keyboard.press(cmdK);
  await expect(page.locator('[data-test="palette-input"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-test="palette-overlay"]')).toHaveCount(0);
});
