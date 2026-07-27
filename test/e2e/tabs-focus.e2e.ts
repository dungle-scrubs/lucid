import { chord, hook, on } from "./locators.ts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * Tabs, attention and where the keyboard lands (catalogue G + I).
 *
 * Every test here runs a real `lucid hub` and drives the shell's tab strip.
 * The shell keeps EVERY open tab's view mounted and hides the inactive ones
 * with `display:none`, so a bare hook matches one element per open tab: the
 * assertions below are either `:visible`-composed, scoped to one tab's own
 * subtree, or deliberately about the HIDDEN twin.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
let cli2: Cli | undefined;

test.afterEach(async () => {
  // Independent processes, reaped concurrently.
  await Promise.all([cli?.cleanup(), cli2?.cleanup()]);
  cli = cli2 = undefined;
  await hub?.stop();
  hub = undefined;
});

/** A copy of the plan fixture under its own document title and heading - the
 *  tab strip names a tab by the document's `<title>`, and the surface's `h1`
 *  is how a test tells which artifact is actually on screen. */
const planNamed = (title: string, heading: string): string =>
  PLAN_V1.replace("<title>Migration plan</title>", `<title>${title}</title>`).replace(
    "Database migration plan",
    heading,
  );

const tabNamed = (page: Page, name: string): Locator =>
  page.locator(hook("shell-tab"), { hasText: name });

const activeTab = (page: Page): Locator => page.locator(`${hook("shell-tab")}[data-active="true"]`);

/** The composer of the tab actually on screen. */
const visibleInput = (page: Page): Locator => page.locator(`${hook("message-input")}:visible`);

/** Every mounted composer's value, in tab order - the only way to say
 *  "the tab I was NOT typing into is untouched" without selecting a hidden
 *  element by its styling. */
const composerValues = (page: Page): Promise<string[]> =>
  on(page)
    .messageInput()
    .evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value));

/**
 * Two tabs in ONE project, so both sit in the same scope and the strip shows
 * both. Returns with the SECOND tab ("Rollout checklist") active, because
 * opening a tab activates it.
 */
const twoTabsOneProject = async (
  page: Page,
): Promise<{ shellUrl: string; other: string; cli: Cli }> => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  const other = join(cli.dir, "rollout.html");
  await writeFile(other, planNamed("Rollout checklist", "Rollout checklist"), "utf8");
  await cli.run(["open", other]);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  // The second artifact is not a tab yet (nothing was listening when it was
  // opened), so it comes in through ⌘K. Deliberately NOT through "+": the
  // "+" has its own test below, and a shared setup that leaned on it would
  // fail in the fixture rather than at the assertion that means something.
  await page.keyboard.press(chord("k"));
  await expect(on(page).paletteInput()).toBeFocused();
  await page.locator(`${hook("palette")} [cmdk-item]`, { hasText: "Rollout checklist" }).click();
  await expect(on(page).paletteOverlay()).toHaveCount(0);
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(activeTab(page)).toContainText("Rollout checklist");
  return { shellUrl: opened.shellUrl, other, cli: opened.cli };
};

test("a question for a background tab raises ITS dot and leaves the front tab alone", async ({
  page,
}) => {
  const { other, cli } = await twoTabsOneProject(page);

  // A is in front, B is the background tab the question is about.
  await tabNamed(page, "Migration plan").click();
  await expect(activeTab(page)).toContainText("Migration plan");

  const group = join(cli.dir, "one-question.json");
  await writeFile(
    group,
    JSON.stringify([
      {
        id: "store",
        header: "Store",
        question: "Which store for the cutover?",
        choices: [
          { id: "pg", label: "Postgres", recommended: true },
          { id: "sqlite", label: "SQLite" },
        ],
      },
    ]),
    "utf8",
  );
  await cli.run(["ask", other, "--group", group]);

  // The dot appears on B WITHOUT B being activated. Its arrival is also the
  // settle signal for the claim below: the shell has handled the event, so
  // "the front tab did not change" is a statement about the state AFTER it
  // rather than a poll that resolved against the value already there.
  const tabB = tabNamed(page, "Rollout checklist");
  const dot = tabB.locator(`${hook("tab-attention")}[data-kind="question"]`);
  await expect(dot).toHaveCount(1);
  await expect(dot).toBeVisible();
  // Nothing was raised: A is still the tab in front, and it wears no dot.
  await expect(activeTab(page)).toContainText("Migration plan");
  await expect(tabNamed(page, "Migration plan").locator(hook("tab-attention"))).toHaveCount(0);
  // ...and the drawer is B's, so it is mounted but not on screen.
  await expect(on(page).questionDrawer()).toHaveCount(1);
  await expect(on(page).questionDrawer()).not.toBeVisible();

  // Landing on B shows the ask; answering it clears the dot.
  await tabB.click();
  await expect(on(page).questionDrawer()).toBeVisible();
  await expect(on(page).choice().first()).toHaveAttribute("aria-checked", "true");
  await on(page).answer().click();
  await expect(on(page).qa()).toHaveCount(1);
  await expect(tabB.locator(`${hook("tab-attention")}[data-kind="question"]`)).toHaveCount(0);
});

test("opening the same artifact twice raises the tab it already has, without remounting it", async ({
  page,
}) => {
  const { shellUrl, cli } = await twoTabsOneProject(page);

  // Mark the FIRST artifact's frame while it is the visible one. The marker
  // lives on that iframe's own window, so it cannot survive a reload or a
  // remount - which is exactly the claim "raised, not remounted" makes.
  const MARKER = "__lucidTabMarker";
  await tabNamed(page, "Migration plan").click();
  await expect(activeTab(page)).toContainText("Migration plan");
  await surfaceOf(page)
    .locator("body")
    .evaluate((el, name) => {
      (el.ownerDocument.defaultView as unknown as Record<string, unknown>)[name] = "kept";
    }, MARKER);

  // Switch away, so raising the tab is a visible change rather than a no-op.
  await tabNamed(page, "Rollout checklist").click();
  await expect(activeTab(page)).toContainText("Rollout checklist");

  // The agent runs `lucid open` on the SAME artifact again.
  const reopened = (await cli.run(["open", cli.artifact])) as { url: string };
  expect(reopened.url).toBe(shellUrl);

  // The tab it already had comes to the front - and it is still one tab.
  await expect(activeTab(page)).toContainText("Migration plan");
  await expect(tabNamed(page, "Migration plan")).toHaveCount(1);
  await expect(on(page).shellTab()).toHaveCount(2);

  // Same window, same frame: nothing was torn down and rebuilt.
  const survived = await surfaceOf(page)
    .locator("body")
    .evaluate(
      (el, name) => (el.ownerDocument.defaultView as unknown as Record<string, unknown>)[name],
      MARKER,
    );
  expect(survived).toBe("kept");
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
});

test("a hidden tab keeps folding events: the reply is already there when you arrive", async ({
  page,
}) => {
  const { other, cli } = await twoTabsOneProject(page);

  // The cursor an agent holds before any of this exists.
  const before = (await cli.run(["wait", other, "--timeout", waitTimeoutSeconds(1)])) as {
    nextCursor: string;
  };

  // Say something from B's composer while B is the tab in front.
  const asked = "Which store are we cutting over to?";
  await visibleInput(page).fill(asked);
  await page.locator(`${hook("send-message")}:visible`).click();
  await expect(on(page).deliveryState()).toHaveAttribute("data-state", "recorded");

  // Now put B in the background.
  await tabNamed(page, "Migration plan").click();
  await expect(activeTab(page)).toContainText("Migration plan");

  // The agent takes delivery of the batch AND answers it - all while B's view
  // is hidden.
  const REPLY = "Postgres, and the backfill runs in one batch.";
  const payload = (await cli.run([
    "wait",
    other,
    "--since",
    before.nextCursor,
    "--reply",
    REPLY,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string };
  expect(payload.status).toBe("feedback");

  // WITHOUT switching: B's hidden pane already holds the reply and the
  // delivery state moved on. `not.toBeVisible()` is what makes this a claim
  // about the background tab rather than about whatever is on screen.
  const reply = page.locator('[data-role="agent"]', { hasText: REPLY });
  await expect(reply).toHaveCount(1);
  await expect(reply).not.toBeVisible();
  const chip = on(page).deliveryState();
  await expect(chip).toHaveAttribute("data-state", "answered");
  await expect(chip).not.toBeVisible();

  // Arriving shows it immediately - there is nothing left to fetch.
  await tabNamed(page, "Rollout checklist").click();
  await expect(reply).toBeVisible();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-state", "answered");
  await expect(page.locator('[data-role="human"]', { hasText: asked })).toBeVisible();
});

test("landing on a tab lands the keyboard in THAT tab's composer", async ({ page }) => {
  await twoTabsOneProject(page);

  // Click the background tab and type without touching anything else.
  await tabNamed(page, "Migration plan").click();
  await expect(visibleInput(page)).toBeFocused();
  const first = "typed straight after clicking the tab";
  await page.keyboard.type(first);
  await expect(visibleInput(page)).toHaveValue(first);
  // The tab that was in front a moment ago is untouched: exactly one composer
  // holds the text, and the other is still empty.
  expect((await composerValues(page)).slice().sort()).toEqual(["", first]);

  // The same promise for the keyboard route: ⌘2 jumps to the second visible
  // tab and the keyboard follows it.
  await page.keyboard.press(chord("2"));
  await expect(activeTab(page)).toContainText("Rollout checklist");
  await expect(visibleInput(page)).toBeFocused();
  const second = "and this one after the digit chord";
  await page.keyboard.type(second);
  await expect(visibleInput(page)).toHaveValue(second);
  expect((await composerValues(page)).slice().sort()).toEqual([second, first].slice().sort());

  // ...and back with ⌘1, where the first draft is exactly as it was left.
  await page.keyboard.press(chord("1"));
  await expect(activeTab(page)).toContainText("Migration plan");
  await expect(visibleInput(page)).toBeFocused();
  await expect(visibleInput(page)).toHaveValue(first);
});

test('"+" deselects the tab you are on; it closes nothing and loses no draft', async ({ page }) => {
  await twoTabsOneProject(page);

  const draft = "the draft must outlive a trip to the pick screen";
  await visibleInput(page).fill(draft);
  await expect(visibleInput(page)).toHaveValue(draft);

  await on(page).tabAdd().click();

  // The deselect landing is the settle signal for everything below: without
  // it, "both tabs are still there" is a poll that resolves against the state
  // from before the click and passes for free.
  await expect(activeTab(page)).toHaveCount(0);
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(tabNamed(page, "Migration plan")).toHaveCount(1);
  await expect(tabNamed(page, "Rollout checklist")).toHaveCount(1);
  // The pick screen it landed on has nothing to offer, because nothing was
  // closed: every artifact in scope is still a tab.
  await expect(on(page).allOpen()).toBeVisible();
  await expect(on(page).pickerRow()).toHaveCount(0);

  // Clicking back returns the tab exactly as it was left.
  await tabNamed(page, "Rollout checklist").click();
  await expect(activeTab(page)).toContainText("Rollout checklist");
  await expect(visibleInput(page)).toHaveValue(draft);
});

test("⌘K over a composer draft types into the palette, and Escape gives the draft back", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);

  // Typed with the keyboard, from inside the composer: the scenario is ⌘K
  // while the caret is already there, which `fill` would not reproduce.
  const draft = "hold this thought while I jump somewhere";
  await on(page).messageInput().click();
  await page.keyboard.type(draft);
  await expect(on(page).messageInput()).toBeFocused();

  await page.keyboard.press(chord("k"));
  await expect(on(page).paletteInput()).toBeFocused();

  const query = "toggle";
  await page.keyboard.type(query);
  // The positive half first: the characters landed in the palette. That is
  // the settle signal for the claim that they did NOT land in the composer.
  await expect(on(page).paletteInput()).toHaveValue(query);
  await expect(on(page).messageInput()).toHaveValue(draft);

  await page.keyboard.press("Escape");
  await expect(on(page).paletteOverlay()).toHaveCount(0);
  await expect(on(page).messageInput()).toHaveValue(draft);
});

test("the palette activates an already-open tab instead of opening a second one", async ({
  page,
}) => {
  await twoTabsOneProject(page);

  await tabNamed(page, "Migration plan").click();
  await expect(activeTab(page)).toContainText("Migration plan");

  await page.keyboard.press(chord("k"));
  await expect(on(page).paletteInput()).toBeFocused();
  // The background tab, picked from the group that exists BECAUSE it is
  // already open - not from a project group, which would be the open path.
  await page
    .locator(`${hook("palette")} [cmdk-group]`, { hasText: "Open tabs" })
    .locator("[cmdk-item]", { hasText: "Rollout checklist" })
    .click();

  await expect(on(page).paletteOverlay()).toHaveCount(0);
  await expect(activeTab(page)).toContainText("Rollout checklist");
  // Activated, not opened again: still two tabs, one of them that one.
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(tabNamed(page, "Rollout checklist")).toHaveCount(1);
  // ...and the keyboard came with it.
  await expect(visibleInput(page)).toBeFocused();
  await expect(surfaceOf(page).locator("h1")).toContainText("Rollout checklist");
});

test("⌘1-9 index the VISIBLE strip, never a tab hidden by the project scope", async ({ page }) => {
  hub = await startHub();
  // Project A: two artifacts in one folder.
  const alpha = await openIntoHub(hub, planNamed("Alpha one", "Alpha one heading"));
  cli = alpha.cli;
  const alphaTwo = join(cli.dir, "alpha-two.html");
  await writeFile(alphaTwo, planNamed("Alpha two", "Alpha two heading"), "utf8");
  await cli.run(["open", alphaTwo]);
  // Project B: two more, in a folder of its own.
  const beta = await openIntoHub(hub, planNamed("Beta one", "Beta one heading"));
  cli2 = beta.cli;
  const betaTwo = join(cli2.dir, "beta-two.html");
  await writeFile(betaTwo, planNamed("Beta two", "Beta two heading"), "utf8");
  await cli2.run(["open", betaTwo]);

  // Open all four as tabs, project A first, so A's tabs are EARLIER in the
  // roster than B's - which is what makes "index the visible strip" and
  // "index every tab" give different answers.
  await page.goto(alpha.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row"), { hasText: "Alpha two" }).click();
  await expect(on(page).shellTab()).toHaveCount(2);

  await on(page).tabAdd().click();
  await on(page).scopeClear().click();
  await page.locator(hook("picker-row"), { hasText: "Beta one" }).click();
  // Opening across projects rescopes the strip: A's two tabs are still open,
  // just not in this scope.
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row"), { hasText: "Beta two" }).click();
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(activeTab(page)).toContainText("Beta two");

  // ⌘1 is the FIRST tab of the strip you can see, not the first tab open.
  await page.keyboard.press(chord("1"));
  await expect(activeTab(page)).toContainText("Beta one");
  await expect(surfaceOf(page).locator("h1")).toContainText("Beta one heading");
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(tabNamed(page, "Alpha one")).toHaveCount(0);
  await expect(tabNamed(page, "Alpha two")).toHaveCount(0);

  // ⌘2 is the second one, and the scope never moved to project A.
  await page.keyboard.press(chord("2"));
  await expect(activeTab(page)).toContainText("Beta two");
  await expect(surfaceOf(page).locator("h1")).toContainText("Beta two heading");
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(tabNamed(page, "Alpha one")).toHaveCount(0);
});
