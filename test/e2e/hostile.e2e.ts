import { on } from "./locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testTitlesIn } from "../../scripts/coverage-check.ts";
import { HOSTILE_DEFECTS, HOSTILE_FIXTURES, type HostileFixture } from "./hostile-fixtures.ts";
import { makeCli, surfaceOf, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * Suite Q: every hostile artifact goes through the ONE loop that matters -
 * pick, note, queue, send, `wait` receives the right target and text (D-017).
 *
 * The corpus module documents what each document does to tooling and which
 * product seam it attacks; this file only drives the loop. A fixture that
 * cannot survive it is a recorded product defect in the plan ledger, never a
 * silently skipped row - and never a weakened assertion.
 *
 * Not on the harness's `cli` fixture: that fixture serves PLAN_V1, and the
 * whole point here is twelve OTHER documents (harness.ts: "a session opened
 * a particular way still builds its own").
 */

let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

const openHostile = async (fixture: HostileFixture): Promise<{ url: string; cursor: string }> => {
  cli = await makeCli(fixture.html);
  for (const sibling of fixture.siblings ?? []) {
    await writeFile(join(cli.dir, sibling.name), sibling.content);
  }
  const opened = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  return { url: opened.url, cursor: opened.nextCursor };
};

test("every corpus fixture is accounted for: surviving the loop, or a recorded defect", () => {
  // The no-silent-caps guard. A fixture that fails and quietly leaves the
  // loop would read as coverage; a defect entry for a fixture that no longer
  // exists would read as debt. Both directions checked, so the only way a
  // fixture changes sides is deliberately, with the ledger updated.
  const ids = new Set(HOSTILE_FIXTURES.map((f) => f.id));
  for (const defectId of HOSTILE_DEFECTS.keys()) {
    expect(ids.has(defectId), `defect ledger names unknown fixture ${defectId}`).toBe(true);
  }
  expect(HOSTILE_FIXTURES.length).toBe(12);

  // ...and the direction a deleted test would escape through: every fixture
  // NOT in the defect ledger must have its loop test declared in this very
  // file. Read out of the source with the coverage checker's own parser, so
  // a renamed or dropped test is red before a browser ever starts.
  const titles = testTitlesIn(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  for (const fixture of HOSTILE_FIXTURES) {
    if (HOSTILE_DEFECTS.has(fixture.id)) continue;
    expect(
      titles.includes(`the loop survives ${fixture.title}`),
      `surviving fixture ${fixture.id} has no loop test`,
    ).toBe(true);
  }
});

/**
 * The one loop, as a body each surviving fixture's test runs. STATIC titles
 * below rather than `test(\`...\${fixture.title}\`)`, and not by preference:
 * the coverage drift check reads titles out of the SOURCE, and an
 * interpolated title deliberately cannot back a covered catalogue row.
 *
 * The five defect fixtures have no test here - not `test.fail()`, because an
 * expected-failure row cannot carry an honest mutation (D-052), and they
 * fail for five DIFFERENT product reasons the plan ledger records precisely.
 * Their catalogue rows stay uncovered; the guard above keeps the skip loud.
 */
const survives =
  (id: string) =>
  async ({ page }: { page: Page }): Promise<void> => {
    const fixture = HOSTILE_FIXTURES.find((f) => f.id === id);
    if (!fixture) throw new Error(`corpus lost fixture ${id}`);
    if (HOSTILE_DEFECTS.has(id)) {
      throw new Error(`${id} is in the defect ledger - its test cannot exist yet`);
    }
    const { url, cursor } = await openHostile(fixture);
    await page.goto(url);

    const surface = surfaceOf(page);
    // The document's own hostile behaviour settles first, so the pick is a
    // statement about the document a human would see, not a race with it.
    await (fixture.settle
      ? fixture.settle(surface)
      : expect(surface.locator(fixture.pick)).toBeVisible());

    await surface.locator(fixture.pick).click();
    await expect(on(page).annotationNote()).toBeVisible();
    await on(page).annotationNote().fill(fixture.note);
    await on(page).addToQueue().click();
    await expect(on(page).queuedAnnotation()).toHaveCount(1);
    await on(page).sendQueue().click();
    await expect(on(page).annotation()).toHaveCount(1);

    // The agent's side: the right text, a target that resolved, and a
    // snippet pinning the PICK. The snippet is capture-time outerHTML, so it
    // proves what was picked, never what resolution chose - the badge-box
    // test below is the one place suite Q pins resolution to a named
    // element, and finding #47 is what the difference costs on a document
    // that rewrites itself.
    const feedback = (await cli?.run([
      "wait",
      cli.artifact,
      "--since",
      cursor,
      "--timeout",
      waitTimeoutSeconds(8),
    ])) as {
      status: string;
      annotations: { note: string; resolved: unknown; target: { snippet?: string } }[];
    };
    expect(feedback.status).toBe("feedback");
    expect(feedback.annotations).toHaveLength(1);
    const annotation = feedback.annotations[0];
    expect(annotation?.note).toBe(fixture.note);
    expect(annotation?.resolved, "the anchor did not resolve against the artifact").toBeTruthy();
    if (fixture.picked) {
      expect(annotation?.target.snippet ?? "").toContain(fixture.picked);
    }
  };

test(
  "the loop survives an artifact with its own full-width overlay at maximum z-index",
  survives("hostile-competing-overlay"),
);
test(
  "the loop survives an artifact whose content lives inside an open shadow root",
  survives("hostile-shadow-dom"),
);
test(
  "the loop survives an artifact whose CSS lives in a linked file",
  survives("hostile-linked-stylesheet"),
);
test(
  "the loop survives an artifact that is a bare fragment - no html, head, or body tags",
  survives("hostile-fragment-only"),
);
test(
  "the loop survives an artifact whose own scripts throw, at load and on every click",
  survives("hostile-throwing-script"),
);
test(
  "the loop survives an artifact stamping one data-lucid-id on four identical siblings",
  survives("hostile-duplicate-ids"),
);

test("picking the third of four identically-stamped rows marks the THIRD", async ({ page }) => {
  // The duplicate-ids fixture's sharper half: payload resolution says "an
  // element resolved", but the human-facing claim is that the MARK sits on
  // the row that was picked. Four identical siblings sharing one
  // data-lucid-id is a generator actively destroying identity, and the
  // disambiguation (9df5eae) has to hold anyway.
  const fixture = HOSTILE_FIXTURES.find((f) => f.id === "hostile-duplicate-ids");
  if (!fixture) throw new Error("corpus lost its duplicate-ids fixture");
  const { url } = await openHostile(fixture);
  await page.goto(url);

  const surface = surfaceOf(page);
  const third = surface.locator("#list li:nth-child(3)");
  await third.click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(fixture.note);
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // The committed mark's badge sits inside the THIRD row's box - not the
  // first's, which is where every ambiguous resolution used to land.
  const badge = surface.locator(".badge");
  await expect(badge).toHaveCount(1);
  const badgeBox = await badge.boundingBox();
  const thirdBox = await third.boundingBox();
  if (!badgeBox || !thirdBox) throw new Error("badge or row has no box to compare");
  const badgeCenterY = badgeBox.y + badgeBox.height / 2;
  expect(
    badgeCenterY >= thirdBox.y && badgeCenterY <= thirdBox.y + thirdBox.height,
    `badge center ${badgeCenterY} sits outside the third row [${thirdBox.y}, ${thirdBox.y + thirdBox.height}]`,
  ).toBe(true);
});
