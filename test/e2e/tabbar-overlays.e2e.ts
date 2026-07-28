import { hook, on, tooltipPopup } from "./locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLAN_V1,
  isHittable,
  openIntoHub,
  overlaps,
  settled,
  startHub,
  type Cli,
  type Hub,
} from "./helpers.ts";

/**
 * Two things that float over the shell, and the 37px strip neither may reach.
 *
 * The tab strip is the only way back out of anything. It is also a plain
 * `flex` row in normal flow - no z-index of its own - so every floating layer
 * in the chrome outranks it in paint order by default, and each one is held off
 * the bar by a single declaration: the projects drawer and its click-away scrim
 * by `top-(--lucid-shell-top,37px)`, the tooltip popup by a 6px outward offset
 * from a trigger that sits against the viewport's top edge.
 *
 * Both failures are invisible to `locator.click()`. Playwright scrolls an
 * element into view and clicks its centre through its own actionability model,
 * which is not `document.elementFromPoint` - a bar covered by a transparent
 * full-width scrim still passes it. So the load-bearing assertion in both tests
 * is `isHittable` (visual.ts): a hit test at the element's own coordinates,
 * asking the question a human's pointer asks.
 *
 * Each test measures its overlay FIRST - that it is present, painted above the
 * strip, and set to receive pointer events - because "nothing intercepted the
 * click" is worth nothing from a fixture where nothing was ever in the way.
 */

let hub: Hub | undefined;
const clis: Cli[] = [];

test.afterEach(async () => {
  await Promise.all(clis.map((c) => c.cleanup()));
  clis.length = 0;
  await hub?.stop();
  hub = undefined;
});

const named = (title: string): string =>
  PLAN_V1.replace("<title>Migration plan</title>", `<title>${title}</title>`).replace(
    "Database migration plan",
    title,
  );

/**
 * A shell holding `count` tabs from ONE project, so the strip shows all of them
 * under a single scope. Extra artifacts land in the first CLI's directory,
 * which is what puts them in the same project.
 */
const shellWithTabs = async (page: Page, count: number): Promise<Cli> => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  const cli = opened.cli;
  clis.push(cli);
  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  for (let i = 1; i < count; i++) {
    const extra = join(cli.dir, `plan-${i}.html`);
    await writeFile(extra, named(`Plan ${i}`), "utf8");
    await cli.run(["open", extra]);
    await expect(on(page).shellTab()).toHaveCount(i + 1);
  }
  await settled(page);
  return cli;
};

/** The topmost element at a viewport point, described in the terms that decide
 *  whether it can swallow a click - and whether it belongs to the strip. */
const layerAt = async (
  page: Page,
  x: number,
  y: number,
): Promise<{
  readonly position: string;
  readonly zIndex: string;
  readonly pointerEvents: string;
  readonly insideTabbar: boolean;
} | null> =>
  on(page)
    .shellTabbar()
    .evaluate(
      (bar: Element, point: { x: number; y: number }) => {
        const at = document.elementFromPoint(point.x, point.y);
        if (!at) return null;
        const style = getComputedStyle(at);
        return {
          position: style.position,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          insideTabbar: bar.contains(at),
        };
      },
      { x, y },
    );

test("the open drawer never reaches the tab strip: the bar keeps taking clicks", async ({
  page,
}) => {
  await shellWithTabs(page, 2);
  const tabs = on(page).shellTab();

  await on(page).drawerToggle().click();
  await expect(on(page).projectsDrawer()).toBeVisible();
  await settled(page);

  // --- the overlay is real, and it stops one pixel short ---
  const bar = await on(page).shellTabbar().boundingBox();
  const drawer = await on(page).projectsDrawer().boundingBox();
  if (!bar || !drawer) throw new Error("the tab strip or the drawer is not rendered");
  // The panel itself begins below the bar rather than beside it.
  expect(
    drawer.y,
    `the drawer panel starts at y=${drawer.y}, inside a strip that ends at y=${bar.y + bar.height}`,
  ).toBeGreaterThanOrEqual(bar.y + bar.height);

  // The scrim is the dangerous half: full-width, `bg-ink-900/40`, and the thing
  // a reader never notices because it is mostly transparent. Probed by
  // coordinate five pixels UNDER the bar, at the horizontal centre of the tabs
  // - if the layer that owns that point is fixed, painted above the strip and
  // accepting pointer events, then the only reason the tabs still work is where
  // its top edge is. That is what makes the assertions below non-vacuous, and
  // it is exactly one CSS token (`top-0`) from being false.
  const justBelow = await layerAt(page, bar.x + bar.width / 2, bar.y + bar.height + 5);
  expect(
    justBelow,
    "nothing at all covers the region below the bar - the drawer is not open",
  ).not.toBeNull();
  expect(justBelow?.insideTabbar, "the point below the bar is still inside the strip").toBe(false);
  expect(justBelow?.position).toBe("fixed");
  expect(Number(justBelow?.zIndex ?? "auto")).toBeGreaterThan(0);
  expect(justBelow?.pointerEvents).toBe("auto");

  // --- and the strip is untouched ---
  // Every control in the bar, hit-tested where a pointer would land.
  const blocked: string[] = [];
  const controls: ReadonlyArray<readonly [string, ReturnType<typeof tabs.nth>]> = [
    ["tab 1", tabs.nth(0)],
    ["tab 2", tabs.nth(1)],
    ["the + button", on(page).tabAdd()],
    ["the scope badge", on(page).drawerToggle()],
  ];
  for (const [what, locator] of controls) {
    if (!(await isHittable(locator))) blocked.push(what);
  }
  expect(
    blocked,
    `the open drawer covers ${blocked.join(", ")} - the strip is the only way out of it`,
  ).toEqual([]);

  // Hittable is not the same as working, so each click is followed through -
  // and the drawer stays open across all three, which is the scenario.
  await tabs.nth(0).click();
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText(
    "Migration plan",
  );
  await expect(on(page).projectsDrawer()).toBeVisible();

  // "+" deselects, which lands the shell on the pick screen. Both sessions are
  // already tabs, so that screen is the "every session is open" state rather
  // than a list of rows - either way it is proof the click was received.
  await on(page).tabAdd().click();
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toHaveCount(0);
  await expect(on(page).allOpen()).toBeVisible();
  await expect(on(page).projectsDrawer()).toBeVisible();

  // The badge last: it is also the way to close what is open, and a drawer
  // whose own toggle is under its own scrim is a trap.
  await on(page).drawerToggle().click();
  await expect(on(page).projectsDrawer()).toHaveAttribute("aria-hidden", "true");
});

test("an open tab tooltip never reaches the strip: neighbours and their × stay hittable", async ({
  page,
}) => {
  await shellWithTabs(page, 3);
  const tabs = on(page).shellTab();
  const tip = tooltipPopup(page);

  // The MIDDLE tab, not the first. Its tooltip is centred on it, so it has a
  // neighbour on each side to reach over - hovering an end tab leaves half the
  // popup pointing at nothing and can only ever exonerate one direction.
  await tabs.nth(1).hover();
  await expect(tip).toBeVisible();
  await settled(page);

  // --- the popup is real, and it is the interceptor kind ---
  const bar = await on(page).shellTabbar().boundingBox();
  const popup = await tip.boundingBox();
  if (!bar || !popup) throw new Error("the tab strip or the tooltip is not rendered");
  // Portalled to <body> at z-100 and accepting pointer events: there is no
  // `pointer-events: none` anywhere in this popup's chain, so nothing about its
  // CONTENT keeps it off the tabs. Placement is the entire defence, which is
  // why the overlap check below is the claim rather than a sanity check.
  const material = await tip.evaluate((el: Element) => {
    const positioner = el.parentElement;
    return {
      pointerEvents: getComputedStyle(el).pointerEvents,
      layer: positioner ? getComputedStyle(positioner).zIndex : "none",
      portalled: el.closest(`[data-test="shell-tabbar"]`) === null,
    };
  });
  expect(material.pointerEvents).toBe("auto");
  expect(Number(material.layer)).toBeGreaterThan(0);
  expect(material.portalled, "the tooltip renders inside the strip's own subtree").toBe(true);

  // --- and both neighbours still answer a pointer ---
  // The × as well as the tab. It is the smaller target and it sits at the tab's
  // INNER edge, nearest whatever the middle tab's tooltip spills over - so it
  // goes first, and a check that only tried the tab body would miss it.
  const blocked: string[] = [];
  for (const [what, index] of [
    ["the left neighbour", 0],
    ["the right neighbour", 2],
  ] as const) {
    if (!(await isHittable(tabs.nth(index)))) blocked.push(what);
    if (!(await isHittable(tabs.nth(index).locator(hook("tab-close")))))
      blocked.push(`${what}'s ×`);
  }
  expect(blocked, `an open tooltip on the middle tab swallows ${blocked.join(", ")}`).toEqual([]);

  // And the reason, so a future failure says which half moved: the popup clears
  // the bar entirely. `side="top"` has no room above a strip pinned to the
  // viewport's top edge, so it collision-flips below and the 6px outward offset
  // is the whole of what keeps it there. Measured: at `sideOffset: -40` the
  // popup lands at y 16-41 across the strip, and the left neighbour's × stops
  // answering elementFromPoint.
  expect(
    await overlaps(tip, on(page).shellTabbar()),
    `the tooltip at y ${popup.y}-${popup.y + popup.height} runs into the strip at y ${bar.y}-${bar.y + bar.height}`,
  ).toBe(false);

  // Followed through, because a control that is uncovered and inert is no
  // better than a covered one: the right neighbour activates, then closes.
  await tabs.nth(2).click();
  const active = page.locator(`${hook("shell-tab")}[data-active="true"]`);
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("Plan 2");
  await active.locator(hook("tab-close")).click();
  await expect(tabs).toHaveCount(2);
});
