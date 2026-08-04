import { chord, hook, on } from "./locators.ts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLAN_V1,
  openIntoHub,
  startHub,
  waitTimeoutSeconds,
  type Cli,
  type Hub,
} from "./helpers.ts";

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
  //
  // 320, with room to spare, and not 520: the project headings sit ON their
  // frame's top edge now rather than inline, so they take no horizontal space
  // and the strip reclaimed all of it - these four tabs measure ~380px
  // together, so 520 genuinely fits and correctly fades nothing. A width well
  // under the content, rather than just under it, keeps this test about
  // overflow instead of about the current padding.
  await page.setViewportSize({ width: 320, height: 700 });
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
  await page.setViewportSize({ width: 320, height: 700 });
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
  // Narrower than the overflow tests above: the marker means a tab whose box is
  // FULLY past the edge, and at 320 the last of these four only straddles it.
  await page.setViewportSize({ width: 240, height: 700 });

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

test("two same-titled tabs in one project are told apart by their tooltips (finding #56)", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  // A second artifact in the SAME project with the IDENTICAL title - the
  // fixture finding #56 measured. The labels are allowed to match now
  // (title-only, D-012); the differentiator the row demands is the tooltip.
  const twin = join(cli.dir, "rollout.html");
  await writeFile(twin, PLAN_V1, "utf8");
  await cli.run(["open", twin]);

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row")).first().click();
  await expect(on(page).shellTab()).toHaveCount(2);

  // Both labels identical and bare - and inside ONE group (same project).
  await expect(on(page).tabGroup()).toHaveCount(1);
  const tabs = on(page).shellTab();
  await expect(tabs.nth(0)).toContainText("Migration plan");
  await expect(tabs.nth(1)).toContainText("Migration plan");

  // Hovering each shows ITS OWN artifact path: the tooltips differ even
  // though the labels cannot.
  const tipFor = async (i: number): Promise<string> => {
    await tabs.nth(i).locator("button").first().hover();
    const tip = page.locator('[data-slot="tooltip-content"]', { hasText: "/" }).last();
    await expect(tip).toBeVisible();
    const text = (await tip.textContent()) ?? "";
    await page.mouse.move(0, 400); // dismiss before the next hover
    return text;
  };
  const first = await tipFor(0);
  const second = await tipFor(1);
  expect(first).not.toBe(second);
  expect([first, second].join(" ")).toContain("rollout.html");
});

test("an evicted background tab still raises its question dot (M3.1)", async ({ page }) => {
  // Cap of ONE connected stream: opening the second tab evicts the first's.
  // The evicted tab's own store goes quiet, so the dot below can only come
  // from the hub's attention map - which is the milestone's claim.
  hub = await startHub({ streamCap: 1 });
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const other = join(cli.dir, "rollout.html");
  await writeFile(other, planNamed("Rollout checklist", "Rollout checklist"), "utf8");
  await cli.run(["open", other]);

  await page.goto(first.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row"), { hasText: "Rollout checklist" }).click();
  await expect(on(page).shellTab()).toHaveCount(2);
  // The second tab is active; the first's stream is the cap's victim.

  const group = join(cli.dir, "one-question.json");
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
  await cli.run(["ask", cli.artifact, "--group", group]);

  // The dot appears on the EVICTED tab, unactivated, fed by the hub.
  const evicted = page.locator(hook("shell-tab"), { hasText: "Migration plan" });
  await expect(evicted.locator(`${hook("tab-attention")}[data-kind="question"]`)).toHaveCount(1);
  // And the front tab did not change - nothing was stolen to show it.
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText(
    "Rollout checklist",
  );
});

test("the pick screen lists across projects and narrows fuzzily (M4.1)", async ({ page }) => {
  hub = await startHub();
  const alpha = await openIntoHub(hub, planNamed("Alpha one", "Alpha one heading"));
  cli = alpha.cli;
  const alphaTwo = join(cli.dir, "alpha-two.html");
  await writeFile(alphaTwo, planNamed("Alpha two", "Alpha two heading"), "utf8");
  await cli.run(["open", alphaTwo]);
  await cli.run(["end", alphaTwo]);
  const beta = await openIntoHub(hub, planNamed("Beta one", "Beta one heading"));
  cli2 = beta.cli;

  // One tab open (Alpha one via ?s=); everything else is a place to GO.
  await page.goto(alpha.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();

  // Cross-project: both projects' openable sessions, grouped, in ONE list.
  await expect(on(page).pickerProject()).toHaveCount(2);
  await expect(on(page).pickerRow()).toHaveCount(2);

  // Fuzzy, undebounced, and the project name and artifact path are part of the
  // value: typing a fragment of the OTHER session leaves only its rows.
  //
  // "Beta one" and not "beta", and the space is load-bearing. Matching is
  // SUBSEQUENCE, and the value ends with the artifact's absolute path through
  // a random `mkdtemp` directory - so a suffix supplying b, e, t, a in order
  // makes the Alpha row match "beta" too. That is the whole of this test's
  // intermittency: measured on a failing run, project `lucid-e2e-Bk2mEb` ->
  // b(B) e(E) t(private) a(alpha) and two rows survived for the full timeout.
  // A query containing a space can only be satisfied by the separators
  // BETWEEN the value's fields, which pins the match to the label rather than
  // to whatever the filesystem handed out.
  await on(page).pickerFilter().fill("Beta one");
  await expect(on(page).pickerRow()).toHaveCount(1);
  await expect(on(page).pickerRow().first()).toContainText("Beta one");
  await on(page).pickerFilter().fill("");
  await expect(on(page).pickerRow()).toHaveCount(2);
});

test("a long list grows a recency band ordered by lastSeen; a short one does not (M4.1, D-024)", async ({
  page,
}) => {
  hub = await startHub();
  const first = await openIntoHub(hub, planNamed("Doc 0", "Doc 0 heading"));
  cli = first.cli;
  // Six MORE artifacts in the same project, opened in order, so lastSeen
  // ordering is knowable: the last-opened is the band's first row.
  for (let i = 1; i <= 6; i++) {
    const p = join(cli.dir, `doc-${i}.html`);
    await writeFile(p, planNamed(`Doc ${i}`, `Doc ${i} heading`), "utf8");
    await cli.run(["open", p]);
    await cli.run(["end", p]);
  }

  await page.goto(first.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();

  // Six openable rows -> a band of five, newest first.
  await expect(on(page).pickerRow()).toHaveCount(6);
  const band = on(page).recentRow();
  await expect(band).toHaveCount(5);
  await expect(band.first()).toContainText("Doc 6"); // most recently seen
});

test("unseen badges survive a reload; restoring is not arriving (M3.2)", async ({ page }) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const other = join(cli.dir, "rollout.html");
  await writeFile(other, planNamed("Rollout checklist", "Rollout checklist"), "utf8");
  await cli.run(["open", other]);

  await page.goto(first.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  await on(page).tabAdd().click();
  await page.locator(hook("picker-row"), { hasText: "Rollout checklist" }).click();
  await expect(on(page).shellTab()).toHaveCount(2);
  // Land on A, so B is the background tab whose growth goes unseen.
  await page.locator(hook("shell-tab"), { hasText: "Migration plan" }).click();
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText(
    "Migration plan",
  );

  // B's log grows while B is in the background: an agent reply lands.
  await cli.run([
    "wait",
    other,
    "--reply",
    "revised while you were away",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);
  const tabB = page.locator(hook("shell-tab"), { hasText: "Rollout checklist" });
  await expect(tabB.locator(`${hook("tab-attention")}[data-kind="unseen"]`)).toHaveCount(1);

  // ⌘R. The restore must NOT count as arriving at B: the badge survives.
  await page.reload();
  await expect(on(page).shellTab()).toHaveCount(2);
  await expect(page.locator(`${hook("shell-tab")}[data-active="true"]`)).toContainText(
    "Migration plan",
  );
  await expect(
    page
      .locator(hook("shell-tab"), { hasText: "Rollout checklist" })
      .locator(`${hook("tab-attention")}[data-kind="unseen"]`),
  ).toHaveCount(1);
});

test("the active tab pours into the header through one bridge surface (M0.1)", async ({ page }) => {
  await twoProjectsFourTabs(page);
  // Wide enough that every tab fits: the claim is about the active tab joining
  // the header, not about scrolling.
  await page.setViewportSize({ width: 1400, height: 700 });

  const activeTab = (): Locator => page.locator(`${hook("shell-tab")}[data-active="true"]`);
  const bridge = on(page).activeTabBridge();

  // Land deterministically on the first tab (twoProjectsFourTabs leaves the
  // last-opened tab active). The bridge is present under it.
  await page.keyboard.press(chord("1"));
  await expect(activeTab()).toContainText("Beta one");
  await expect(bridge).toBeVisible();

  // Source-level: the three sites that must form one surface all reference the
  // chrome-surface token - no ink-800 literal remains at any of them. Asserted
  // on the class, which is where the claim lives (the token is shared by name).
  const refs = await page.evaluate(() => ({
    tab: document
      .querySelector('[data-test="shell-tab"][data-active="true"]')
      ?.className.includes("bg-chrome-surface"),
    bridge: document
      .querySelector('[data-test="active-tab-bridge"]')
      ?.className.includes("bg-chrome-surface"),
    header: document.querySelector("header")?.className.includes("bg-chrome-surface"),
  }));
  expect(refs.tab).toBe(true);
  expect(refs.bridge).toBe(true);
  expect(refs.header).toBe(true);

  // The load-bearing visual claim: the bridge and the header below it share ONE
  // surface color, so the strip and the header read as joined with no seam.
  // (The active tab is a Base UI context-menu trigger whose own background is
  // composed through a cascade a class read cannot see, so the bridge - a plain
  // div wearing the same token - is the surface the seam claim is tested on.)
  const colors = await page.evaluate(() => {
    const header = document.querySelector("header");
    const b = document.querySelector('[data-test="active-tab-bridge"]');
    return {
      header: header ? getComputedStyle(header).backgroundColor : null,
      bridge: b ? getComputedStyle(b).backgroundColor : null,
    };
  });
  expect(colors.header).toBeTruthy();
  expect(colors.bridge).toBe(colors.header);

  // The bridge's top edge sits at the active tab's bottom edge: it covers the
  // seam from the tab down through the moat (group frame border, row padding,
  // the strip's own border-b) to the header. Allow 1px for sub-pixel rounding.
  // Selectors pass in through hook() so no raw data-test literal lives in the
  // evaluate body (check-locators).
  const seam = await page.evaluate(
    (sels: { tab: string; bridge: string }) => {
      const tab = document.querySelector(sels.tab) as HTMLElement;
      const b = document.querySelector(sels.bridge) as HTMLElement;
      return {
        tabBottom: tab.getBoundingClientRect().bottom,
        bridgeTop: b.getBoundingClientRect().top,
      };
    },
    { tab: `${hook("shell-tab")}[data-active="true"]`, bridge: hook("active-tab-bridge") },
  );
  expect(Math.abs(seam.bridgeTop - seam.tabBottom)).toBeLessThanOrEqual(1);

  // Switching tabs moves the bridge to the new active tab's column - its left
  // changes. Beta one is first in its group; Alpha two is in the other group,
  // so the two columns differ. The bridge follows the active tab through a
  // data-active MutationObserver, which fires on a microtask after the click -
  // so wait for the position to land rather than racing the read.
  const before = await bridge.evaluate((el) => (el as HTMLElement).getBoundingClientRect().left);
  await page.locator(hook("shell-tab"), { hasText: "Alpha two" }).click();
  await expect(activeTab()).toContainText("Alpha two");
  await page.waitForFunction(
    (prior: number) => {
      const b = document.querySelector('[data-test="active-tab-bridge"]') as HTMLElement | null;
      return b !== null && b.getBoundingClientRect().left !== prior;
    },
    before,
    { timeout: 3000 },
  );
});
