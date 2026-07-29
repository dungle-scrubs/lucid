import { chord, hook, on } from "./locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLAN_V1, openIntoHub, startHub, type Cli, type Hub } from "./helpers.ts";

/**
 * The grouped tab strip (plan 03, M2.2): every open tab in one row, grouped by
 * project - an inert heading per run, and edge fades that exist only while
 * content actually overflows that edge (D-013).
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
let cli2: Cli | undefined;

test.afterEach(async () => {
  await Promise.all([cli?.cleanup(), cli2?.cleanup()]);
  cli = cli2 = undefined;
  await hub?.stop();
  hub = undefined;
});

const planNamed = (title: string, heading: string): string =>
  PLAN_V1.replace("<title>Migration plan</title>", `<title>${title}</title>`).replace(
    "Database migration plan",
    heading,
  );

/** Two projects, two tabs each, opened tether-first so group order and listing
 *  order disagree - which is what makes "first-open, never reorder" testable. */
const twoProjectsFourTabs = async (page: Page): Promise<void> => {
  hub = await startHub();
  const beta = await openIntoHub(hub, planNamed("Beta one", "Beta one heading"));
  cli2 = beta.cli;
  const betaTwo = join(cli2.dir, "beta-two.html");
  await writeFile(betaTwo, planNamed("Beta two", "Beta two heading"), "utf8");
  await cli2.run(["open", betaTwo]);
  const alpha = await openIntoHub(hub, planNamed("Alpha one", "Alpha one heading"));
  cli = alpha.cli;
  const alphaTwo = join(cli.dir, "alpha-two.html");
  await writeFile(alphaTwo, planNamed("Alpha two", "Alpha two heading"), "utf8");
  await cli.run(["open", alphaTwo]);

  // Boot on Beta's shell URL, then open the rest through the pick screen in
  // B, B, A, A order - Beta's group forms first.
  await page.goto(beta.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  for (const name of ["Beta two", "Alpha one", "Alpha two"]) {
    await on(page).tabAdd().click();
    await page.locator(hook("picker-row"), { hasText: name }).click();
  }
  await expect(on(page).shellTab()).toHaveCount(4);
};

test("tabs group by project: one inert heading per run, bare titles on the tabs", async ({
  page,
}) => {
  await twoProjectsFourTabs(page);

  // Two runs, one heading each, in first-open order: Beta before Alpha.
  await expect(on(page).tabGroup()).toHaveCount(2);
  const labels = on(page).groupLabel();
  await expect(labels).toHaveCount(2);
  // The heading names the project (its folder's basename); the full path rides
  // the tooltip, not the strip.
  const betaProject = cli2?.dir ?? "";
  const alphaProject = cli?.dir ?? "";
  await expect(labels.nth(0)).toHaveText(betaProject.split("/").pop() ?? "");
  await expect(labels.nth(1)).toHaveText(alphaProject.split("/").pop() ?? "");

  // The heading is INERT (D-022): a span, not a button - nothing to click.
  const tag = await labels.nth(0).evaluate((el) => el.tagName);
  expect(tag).toBe("SPAN");

  // Tabs read their bare titles (D-012) - no `· project` qualifier even though
  // nothing collides here; the group is the address.
  await expect(page.locator(hook("shell-tab"), { hasText: "Alpha one" })).toHaveCount(1);
  await expect(page.locator(hook("shell-tab"), { hasText: "·" })).toHaveCount(0);
});

test("groups sit where they first opened and NEVER reorder (D-010)", async ({ page }) => {
  await twoProjectsFourTabs(page);

  const order = async (): Promise<string[]> => on(page).groupLabel().allTextContents();
  const initial = await order();
  expect(initial).toHaveLength(2);

  // Activating a tab in the SECOND group must not hoist its group.
  await page.locator(hook("shell-tab"), { hasText: "Alpha one" }).click();
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText("Alpha one");
  expect(await order()).toEqual(initial);

  // Closing and reopening a tab in the FIRST group keeps it first: the group
  // still holds its other tab, so its slot never vacated.
  await page.locator(hook("shell-tab"), { hasText: "Beta two" }).locator(hook("tab-close")).click();
  await expect(on(page).shellTab()).toHaveCount(3);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row"), { hasText: "Beta two" }).click();
  await expect(on(page).shellTab()).toHaveCount(4);
  expect(await order()).toEqual(initial);
});

test("edge fades exist only while content overflows that edge (D-013)", async ({ page }) => {
  await twoProjectsFourTabs(page);

  // Wide window: everything fits, no fade on either edge.
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(on(page).tabbarFadeLeft()).toHaveCount(0);
  await expect(on(page).tabbarFadeRight()).toHaveCount(0);

  // Narrow window: content extends past the right edge only - the left edge
  // is at scroll 0 and must NOT claim hidden tabs.
  await page.setViewportSize({ width: 520, height: 700 });
  await expect(on(page).tabbarFadeRight()).toHaveCount(1);
  await expect(on(page).tabbarFadeLeft()).toHaveCount(0);

  // Scrolled to the far end: the sides swap.
  await on(page)
    .shellTabbar()
    .evaluate((bar) => {
      const scroller = bar.firstElementChild as HTMLElement;
      scroller.scrollLeft = scroller.scrollWidth;
    });
  await expect(on(page).tabbarFadeLeft()).toHaveCount(1);
  await expect(on(page).tabbarFadeRight()).toHaveCount(0);
});

/** The active tab's box sits inside the scroller's visible window. */
const activeTabInView = async (page: Page): Promise<boolean> =>
  on(page)
    .shellTabbar()
    .evaluate((bar) => {
      const scroller = bar.firstElementChild as HTMLElement;
      const tab = scroller.querySelector('[data-test="shell-tab"][data-active="true"]');
      if (!tab) return false;
      const t = (tab as HTMLElement).getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return t.left >= s.left - 1 && t.right <= s.right + 1;
    });

test("every activation path scrolls the tab into view on a narrow strip (M2.3, R1)", async ({
  page,
}) => {
  await twoProjectsFourTabs(page);
  await page.setViewportSize({ width: 480, height: 700 });
  await expect(on(page).tabbarFadeRight()).toHaveCount(1); // genuinely overflowing

  // ⌘1 - the FIRST tab, currently scrolled with. Then ⌘4 - the far end.
  await page.keyboard.press(chord("1"));
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText("Beta one");
  expect(await activeTabInView(page)).toBe(true);
  await page.keyboard.press(chord("4"));
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText("Alpha two");
  expect(await activeTabInView(page)).toBe(true);

  // Palette selection is another path through the same choke point.
  await page.keyboard.press(chord("k"));
  await page.locator(`${hook("palette")} [cmdk-item]`, { hasText: "Beta two" }).click();
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText("Beta two");
  expect(await activeTabInView(page)).toBe(true);

  // Bracket-stepping walks the strip; each stop is visible.
  await page.keyboard.press(`${chord("Shift+]")}`);
  expect(await activeTabInView(page)).toBe(true);
});

test("an off-screen question marks the fade on its side (D-023)", async ({ page }) => {
  await twoProjectsFourTabs(page);
  await page.setViewportSize({ width: 480, height: 700 });

  // Land on the FIRST tab so the last one is far off the right edge.
  await page.keyboard.press(chord("1"));
  expect(await activeTabInView(page)).toBe(true);
  await expect(on(page).fadeAttention()).toHaveCount(0); // no attention yet

  // A question lands on the far-right tab (Alpha two) while it is hidden.
  const alphaTwo = join(cli?.dir ?? "", "alpha-two.html");
  const group = join(cli?.dir ?? "", "one-question.json");
  await writeFile(
    group,
    JSON.stringify([
      {
        id: "q",
        header: "Pick",
        question: "Which one?",
        choices: [{ id: "a", label: "A", recommended: true }],
      },
    ]),
    "utf8",
  );
  await cli?.run(["ask", alphaTwo, "--group", group]);

  // The right fade wears the marker: hidden attention, said at the edge.
  const marker = on(page).fadeAttention();
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-side", "right");

  // Scrolling the tab into view clears it - the attention is no longer hidden.
  await page.keyboard.press(chord("4"));
  await expect(on(page).fadeAttention()).toHaveCount(0);
});
