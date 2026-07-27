import { on } from "../locators.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "../harness.ts";
import { surfaceOf, waitTimeoutSeconds } from "../helpers.ts";

/**
 * M4.1 - queued annotations survive a reload, the way messages already do.
 *
 * The queue lived only in component state while the message outbox persisted
 * per-key in localStorage - so a reload kept an undelivered MESSAGE and
 * silently destroyed every queued ANNOTATION, with no warning and no recovery
 * card. The asymmetry was the finding. The queue now persists the same way
 * the outbox does (D-054): written on queue and edit, forgotten on send and
 * remove, restored on load.
 *
 * Durability is the claim, so it is proved against a genuinely new page
 * instance - and a restored item is proved still LIVE, not a husk: it can be
 * removed, and what remains still sends and resolves against its anchor.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * restore `queue: []` in `store.ts`'s initial state and every card below is
 * gone after the first reload.
 */

const queueOn = async (page: Page, artifactSelector: string, note: string): Promise<void> => {
  await surfaceOf(page).locator(artifactSelector).click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill(note);
  await on(page).addToQueue().click();
};

test("queued annotations survive a reload, and the survivors still send", async ({ page, cli }) => {
  const opened = (await cli.run(["open", cli.artifact])) as {
    url: string;
    nextCursor: string;
    session: string;
  };
  await page.goto(opened.url);

  // TWO, on different elements, for the same reason the outbox test uses two:
  // one item cannot tell "persisted the queue" from "persisted the last
  // write", and each item must come back on its own key. The SECOND is a
  // large PASTE, because a placeholder note is a pointer into the page-local
  // paste store: persisting the pointer instead of the words came back from
  // a reload as "[Pasted text #1 +12 lines]" and sent itself to the agent
  // verbatim.
  const first = "Backfill nightly, not in one batch.";
  const wall = Array.from({ length: 12 }, (_, i) => `log line ${i}`).join("\n");
  await queueOn(page, 'li[data-lucid-id="step-backfill"]', first);
  await surfaceOf(page).locator("#note").click();
  await expect(on(page).annotationNote()).toBeVisible();
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const el = document.querySelector('[data-test="annotation-note"]');
    el?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, wall);
  await expect(on(page).annotationNote()).toHaveValue("[Pasted text #1 +12 lines]");
  await on(page).addToQueue().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(2);

  // A genuinely new page instance: nothing in memory survives this - least of
  // all the paste store the placeholder pointed into.
  await page.goto("about:blank");
  await page.goto(opened.url);
  const cards = on(page).queuedAnnotation();
  await expect(cards, "the queue did not survive the reload").toHaveCount(2);
  await expect(cards.first()).toContainText(first);
  // The restored card holds the WORDS. The placeholder died with the page
  // that minted it, and showing it here would be showing a dangling pointer.
  await expect(cards.last()).toContainText("log line 0");
  await expect(cards.last()).not.toContainText("Pasted text");

  // A restored card is still a card: Remove works, and is itself durable -
  // the removed item must not resurrect as a ghost on the next load. And a
  // CORRUPT entry beside the good one - another tool's key, a stale schema -
  // is skipped, not rendered: an earlier validator admitted any object, one
  // forged target threw in the React tree on every load, and BOTH cards
  // vanished until localStorage was cleared by hand.
  await on(cards.first()).removeQueued().click();
  await expect(on(page).queuedAnnotation()).toHaveCount(1);
  // The forged key is DERIVED from a key the product itself wrote, never
  // restated: a hardcoded `lucid:queue:` prefix would go quietly stale if the
  // scheme moved, and this test would then assert against a key nothing
  // reads - passing for the wrong reason. No real key = loud failure.
  await page.evaluate(() => {
    const real = Object.keys(localStorage).find((k) => k.includes(":queue:"));
    if (!real) throw new Error("no queued item in storage to derive the key scheme from");
    const forgedKey = `${real.slice(0, real.lastIndexOf(":") + 1)}forged`;
    localStorage.setItem(
      forgedKey,
      JSON.stringify({
        id: "forged",
        targets: [{ kind: "elephant", nope: true }],
        note: "not a real anchor",
        at: new Date().toISOString(),
        images: [],
      }),
    );
  });
  await page.goto("about:blank");
  await page.goto(opened.url);
  await expect(
    on(page).queuedAnnotation(),
    "a removed item came back, a forged one rendered, or the forged one took the page down",
  ).toHaveCount(1);
  await expect(on(page).queuedAnnotation()).toContainText("log line 0");

  // And a restored item still DRIVES the POST it was written for: the note
  // reaches the agent and its anchor still resolves. Storage that renders a
  // card but cannot send it would pass everything above.
  await on(page).sendQueue().click();
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    opened.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string; annotations: { note: string; resolved: unknown }[] };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations).toHaveLength(1);
  // Every line of the paste, not the placeholder that stood in for it: the
  // agent reads what was actually pasted, across a page life it never saw.
  const note = feedback.annotations[0]?.note ?? "";
  expect(note).not.toContain("Pasted text");
  expect(note.split("\n")).toHaveLength(12);
  expect(note).toContain("log line 11");
  // Resolution is the proof the restored TARGET came through intact, not only
  // the note: a mangled anchor still POSTs fine and still renders a card.
  expect(feedback.annotations[0]?.resolved).toBeTruthy();
});
