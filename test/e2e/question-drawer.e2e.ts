import { hook, on } from "./locators.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  PLAN_V1,
  openIntoHub,
  startHub,
  surfaceOf,
  type Cli,
  type Hub,
  waitTimeoutSeconds,
} from "./helpers.ts";

/**
 * The question drawer (D11-D14): a grouped ask rises over the SURFACE, the
 * artifact stays live above it, previews are sandboxed, and the question only
 * enters the transcript once it is answered.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
});

/** A model-authored wireframe that also tries to run script. The drawer renders
 *  it in a sandbox with an EMPTY allowlist, so the marker never appears. */
const PREVIEW_HTML = [
  '<div id="wire">Postgres wireframe</div>',
  "<script>",
  "document.body.insertAdjacentHTML('beforeend','<div id=\"pwned\">pwned</div>');",
  "try { parent.__lucidPwned = true; } catch (e) {}",
  "</script>",
].join("");

const GROUP = [
  {
    id: "store",
    header: "Store",
    question: "Which store for the cutover?",
    choices: [
      {
        id: "pg",
        label: "Postgres",
        description: "managed, boring",
        recommended: true,
        preview: { html: PREVIEW_HTML },
      },
      { id: "sqlite", label: "SQLite", preview: "+--------+\n| SQLite |\n+--------+" },
    ],
  },
  {
    id: "cutover",
    header: "Cutover",
    question: "When do we cut over?",
    requiresReason: true,
    choices: [
      { id: "week", label: "This week" },
      { id: "quarter", label: "Next quarter" },
    ],
  },
  {
    id: "owner",
    header: "Owner",
    question: "Who owns the rollback?",
    choices: [{ id: "me", label: "The migration author" }],
  },
];

/** Ask the grouped question through the CLI, exactly as an agent would. */
const askGroup = async (c: Cli): Promise<void> => {
  const file = join(c.dir, "group.json");
  await writeFile(file, JSON.stringify(GROUP));
  await c.run(["ask", c.artifact, "--group", file]);
};

test("a grouped question rises as a drawer, gates on its reason, and answers as one unit", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // The cursor an agent holds before the answer exists.
  const before = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(1)])) as {
    nextCursor: string;
  };

  await askGroup(cli);

  const drawer = on(page).questionDrawer();
  await expect(drawer).toBeVisible();
  await expect(on(page).questionTab()).toHaveCount(3);

  // The artifact is still there to work on: a drawer covers its own band, it
  // does not take the screen.
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // Single-choice pre-selects the recommended option (D12), so the common case
  // is one keystroke from done - and that tab already reads as answered.
  const choices = on(page).choice();
  await expect(choices.first()).toHaveAttribute("aria-checked", "true");
  await expect(on(page).questionTab().first()).toHaveAttribute("data-answered", "true");

  // Question 2 requires a reason: choosing is not enough, and the drawer says
  // so by refusing to advance until it is filled.
  await on(page).questionTab().nth(1).click();
  await page.locator(hook("choice"), { hasText: "This week" }).click();
  await expect(on(page).answer()).toBeDisabled();
  await expect(on(page).questionTab().nth(1)).toHaveAttribute("data-answered", "false");
  await on(page).reason().fill("the maintenance window is already booked");
  await expect(on(page).answer()).toBeEnabled();

  // Advance to the last question and answer it through the custom "Other" row -
  // typing is what selects it.
  await on(page).answer().click();
  await expect(on(page).question()).toContainText("Who owns the rollback?");
  await on(page).customAnswer().fill("the platform team");

  await on(page).answer().click();

  // Answered -> the drawer lowers, and the whole ask lands in the record as ONE
  // question+answer item (D14).
  await expect(drawer).toHaveCount(0);
  await expect(on(page).questionReopen()).toHaveCount(0);
  await expect(on(page).qa()).toHaveCount(1);
  await expect(on(page).qa()).toContainText("Which store for the cutover?");
  await expect(on(page).qaAnswer().first()).toContainText("Postgres");

  // The agent reads per-item answers AND one combined summary line.
  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    before.nextCursor,
    "--timeout",
    "8",
  ])) as {
    questions?: {
      answered: boolean;
      answer?: string;
      answerItems?: {
        id: string;
        selected?: { label: string }[];
        text?: string;
        reason?: string;
      }[];
    }[];
  };
  const q = payload.questions?.[0];
  expect(q?.answered).toBe(true);
  expect(q?.answerItems).toHaveLength(3);
  expect(q?.answerItems?.[0]?.selected?.[0]?.label).toBe("Postgres");
  expect(q?.answerItems?.[1]?.reason).toContain("maintenance window");
  expect(q?.answerItems?.[2]?.text).toBe("the platform team");
  expect(q?.answer).toContain("Store -> Postgres");
  expect(q?.answer).toContain("Owner -> the platform team");
});

test("Enter on Skip declines; it never submits the drawer's draft as a decision", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  const before = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(1)])) as {
    nextCursor: string;
  };
  // A ONE-question ask, so the drawer's draft (the recommended choice, already
  // selected) is submittable the instant it arrives - which is exactly when
  // Enter on another control must not send it.
  const file = join(cli.dir, "one.json");
  await writeFile(file, JSON.stringify([GROUP[0]]));
  await cli.run(["ask", cli.artifact, "--group", file]);
  await expect(on(page).questionDrawer()).toBeVisible();
  await expect(on(page).choice().first()).toHaveAttribute("aria-checked", "true");

  await on(page).skip().focus();
  await page.keyboard.press("Enter");

  await expect(on(page).questionDrawer()).toHaveCount(0);
  await expect(on(page).qa()).toContainText("Skipped");

  // The record says DECLINED, with no answer the human never gave.
  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    before.nextCursor,
    "--timeout",
    "8",
  ])) as { questions?: { skipped?: boolean; answer?: string; answerItems?: unknown[] }[] };
  const q = payload.questions?.[0];
  expect(q?.skipped).toBe(true);
  expect(q?.answer).toBeUndefined();
  expect(q?.answerItems).toBeUndefined();
});

test("an HTML preview renders in a sandbox: the wireframe paints, its script never runs", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  await askGroup(cli);
  await expect(on(page).questionDrawer()).toBeVisible();

  // ONE frame per preview at any width - the pane is the only place a preview
  // is instantiated, so this locator can never be ambiguous.
  await expect(on(page).previewFrame()).toHaveCount(1);
  const preview = page.frameLocator(hook("preview-frame"));
  await expect(preview.locator("#wire")).toContainText("Postgres wireframe");

  // ...but nothing in it executes: no node the script would have appended, and
  // no marker on the viewer's own window. Model HTML is never trusted (D13).
  await expect(preview.locator("#pwned")).toHaveCount(0);
  expect(await page.evaluate(() => "__lucidPwned" in window)).toBe(false);

  // A string preview stays inert monospace text rather than markup.
  await page.locator(hook("choice"), { hasText: "SQLite" }).hover();
  await expect(on(page).previewText().first()).toContainText("SQLite");
});

test("Escape lowers the drawer; the reopen bar brings it back with the draft intact", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  await askGroup(cli);
  await expect(on(page).questionDrawer()).toBeVisible();

  // Draft an answer that is NOT the pre-selected one, plus a typed reason on
  // another question, so the restore proves more than a default.
  await page.locator(hook("choice"), { hasText: "SQLite" }).click();
  await on(page).questionTab().nth(1).click();
  await on(page).reason().fill("we can wait for the quiet week");

  await page.keyboard.press("Escape");
  await expect(on(page).questionDrawer()).toHaveCount(0);
  // Lowered, never lost: the bar names what is still owed, and the tab keeps
  // its attention dot.
  const reopen = on(page).questionReopen();
  await expect(reopen).toContainText("3 questions waiting");
  await expect(on(page).tabAttention()).toBeVisible();

  await reopen.click();
  await expect(on(page).questionDrawer()).toBeVisible();
  // Same tab, same reason, and the non-default choice survived on question 1.
  await expect(on(page).reason()).toHaveValue("we can wait for the quiet week");
  await on(page).questionTab().first().click();
  await expect(page.locator(hook("choice"), { hasText: "SQLite" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
