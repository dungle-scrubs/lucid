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

const openHostile = async (
  fixture: HostileFixture,
): Promise<{ session: Cli; url: string; cursor: string }> => {
  cli = await makeCli(fixture.html);
  for (const sibling of fixture.siblings ?? []) {
    await writeFile(join(cli.dir, sibling.name), sibling.content);
  }
  const opened = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  return { session: cli, url: opened.url, cursor: opened.nextCursor };
};

/** Pick an element, write the note, queue it, send the queue - the human
 *  half of the loop, spelled once for the loop body and the badge test. */
const pickQueueSend = async (
  page: Page,
  surface: ReturnType<typeof surfaceOf>,
  selector: string,
  note: string,
): Promise<void> => {
  await surface.locator(selector).click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(note);
  await on(page).addToQueue().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(1);
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);
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

  // ...and the THIRD copy of the corpus: suite Q in the catalogue. Its id
  // set must equal the fixture id set, and a row is uncovered exactly when
  // its fixture is in the defect ledger - so a fixed fixture whose row was
  // never flipped to covered is red here, before coverage-check ever runs.
  const catalogue = JSON.parse(
    readFileSync(fileURLToPath(new URL("./catalogue.json", import.meta.url)), "utf8"),
  ) as { suites: { name: string; scenarios: { id: string; status: string }[] }[] };
  const suiteQ = catalogue.suites.find((s) => s.name.startsWith("Q."));
  expect(suiteQ, "suite Q left the catalogue").toBeDefined();
  const rowIds = new Set((suiteQ?.scenarios ?? []).map((r) => r.id));
  expect([...rowIds].sort()).toEqual([...ids].sort());
  for (const row of suiteQ?.scenarios ?? []) {
    expect(
      row.status === "uncovered",
      `catalogue row ${row.id} is ${row.status} but the defect ledger says ${HOSTILE_DEFECTS.has(row.id) ? "defect" : "survivor"}`,
    ).toBe(HOSTILE_DEFECTS.has(row.id));
  }
});

/**
 * The one loop, as a body each surviving fixture's test runs. STATIC titles
 * below rather than `test(\`...\${fixture.title}\`)`, and not by preference:
 * the coverage drift check reads titles out of the SOURCE, and an
 * interpolated title deliberately cannot back a covered catalogue row.
 *
 * The defect ledger is EMPTY as of plan 05 M2.2 - every fixture in the corpus
 * now runs this loop. A future defect goes back in `HOSTILE_DEFECTS` with its
 * finding, loses its test here, and its catalogue row returns to `uncovered`;
 * the guard above enforces all three together in both directions.
 */
const survives =
  (id: string) =>
  async ({ page }: { page: Page }): Promise<void> => {
    const fixture = HOSTILE_FIXTURES.find((f) => f.id === id);
    if (!fixture) throw new Error(`corpus lost fixture ${id}`);
    if (HOSTILE_DEFECTS.has(id)) {
      throw new Error(`${id} is in the defect ledger - its test cannot exist yet`);
    }
    const { session, url, cursor } = await openHostile(fixture);
    await page.goto(url);

    const surface = surfaceOf(page);
    // The document's own hostile behaviour settles first, so the pick is a
    // statement about the document a human would see, not a race with it -
    // and where the hostile ingredient could silently fail to arrive, the
    // fixture proves its presence before the loop starts.
    await (fixture.settle
      ? fixture.settle(surface)
      : expect(surface.locator(fixture.pick)).toBeVisible());
    await fixture.proof?.(surface);

    await pickQueueSend(page, surface, fixture.pick, fixture.note);

    // The agent's side: the right text, a target that resolved, and a
    // snippet pinning the PICK. The snippet is capture-time outerHTML, so it
    // proves what was picked, never what resolution chose - the badge-box
    // test below is the one place suite Q pins resolution to a named
    // element, and finding #47 is what the difference costs on a document
    // that rewrites itself.
    const feedback = (await session.run([
      "wait",
      session.artifact,
      "--since",
      cursor,
      "--timeout",
      waitTimeoutSeconds(8),
    ])) as {
      status: string;
      annotations: {
        note: string;
        resolved: unknown;
        confidence?: string;
        target: { snippet?: string };
      }[];
    };
    expect(feedback.status).toBe("feedback");
    expect(feedback.annotations).toHaveLength(1);
    const annotation = feedback.annotations[0];
    expect(annotation?.note).toBe(fixture.note);
    expect(annotation?.resolved, "the anchor did not resolve against the artifact").toBeTruthy();
    // How it resolved, asserted for EVERY fixture (plan 05, M2.2, #47) - not
    // only the one that declares `"low"`. Undeclared means the fixture claims
    // an exact match, so a fixture that quietly starts resolving by position
    // reds here rather than passing as "resolved" like the rest.
    expect(
      annotation?.confidence,
      `${id} reported confidence ${String(annotation?.confidence)}; the fixture declares ${String(fixture.confidence)}`,
    ).toBe(fixture.confidence);
    // Unconditional: every fixture declares the text that pins its pick, so
    // an empty `picked` cannot quietly switch this assertion off.
    expect(annotation?.target.snippet ?? "").toContain(fixture.picked);
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
test(
  "the loop survives an artifact whose <base> re-roots every URL to a foreign origin",
  // Was defect #45: the path-absolute bootstrap src resolved against the
  // document base, so a foreign <base href> re-rooted it. The src is
  // ORIGIN-absolute now (plan 04, M2.3) - <base> cannot move it.
  survives("hostile-base-tag"),
);
test(
  "the loop survives an artifact that rewrites its own DOM after load",
  // Was defect #47: resolution runs against the SAVED skeleton, so a document
  // hydrated in the browser could only ever match by position - and the
  // payload reported that guess as a plain `resolved: true`. It still matches
  // by position; the annotation now says `confidence: "low"` (plan 05, M2.2),
  // which is the honest floor. Correct live-DOM re-resolution is NOT built
  // here (D-003).
  survives("hostile-self-rewriting"),
);
test(
  "the loop survives an artifact whose capture-phase handlers swallow every event",
  // Was defect #43: the artifact's window-capture stopPropagation ran ahead
  // of the overlay's document-level listeners and starved picking. The
  // overlay listens at window capture now (plan 04, M2.2) - co-target
  // listeners all run regardless of stopPropagation.
  survives("hostile-prevent-default"),
);
test(
  "the loop survives an artifact carrying its own CSP meta",
  // Was defect #42: the document-authored CSP blocked the injected bootstrap
  // silently. The meta is lifted into the response header with nonced
  // script-src/style-src now (plan 04, M2.1) - the artifact's own governance
  // survives; the nonce names only what Lucid injected.
  survives("hostile-csp-meta"),
);
test(
  "the loop survives an artifact the parser has to repair, holding a literal </body> in a textarea",
  // Was defect #44: inject.ts anchored the bootstrap on the first raw
  // `</body>` in the source, which this fixture holds as textarea TEXT - the
  // bootstrap rendered as content and the overlay never booted. The splice
  // now lands at the close the parser honors (plan 04, M1.1).
  survives("hostile-malformed"),
);
test(
  "the loop survives an artifact with eighteen thousand sibling nodes",
  // Was defect #46 (diagnosis D-065): the per-element sibling scan went
  // super-quadratic on flat fan-out - the committed card never rendered and
  // `lucid wait` hung. The index is one pass now (plan 04, M1.2).
  survives("hostile-huge-dom"),
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
  // The FIXTURE's own pick selector, so the corpus cannot drift away from
  // this test's title while both stay green.
  const third = surface.locator(fixture.pick);
  await pickQueueSend(page, surface, fixture.pick, fixture.note);
  // Sent marks are quiet by default; the card's link paints the one this
  // test measures.
  await on(page).toggleMark().click();

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
