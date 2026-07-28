import { on } from "../locators.ts";
import { expect, test } from "../harness.ts";
import { surfaceOf } from "../helpers.ts";

/**
 * M5.1 - two messages written in the same millisecond do not blank the viewer.
 *
 * The message timeline keyed each entry `${role}-${at}`, and `at` is one ISO
 * timestamp stamped per APPEND at millisecond precision - so any two messages
 * that land in the same millisecond share an id. A duplicate id makes
 * assistant-ui's MessageRepository throw, React unmounts the tree, and the
 * review surface goes BLANK: every unsent note and undelivered message gone,
 * with no warning and nothing to recover from.
 *
 * This is the same failure the partial-batch fix closed for ANNOTATIONS, found
 * by the M5.1 adversarial review still reachable through the messages door -
 * which is why the id now comes from the event's own seq, unique per append.
 *
 * The fixture posts a burst through the API rather than the composer: the
 * composer cannot type fast enough to collide, and the log absolutely can.
 */

test("messages appended in the same millisecond render, and do not blank the page", async ({
  page,
  cli,
}) => {
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // An exception here IS the defect - assert on the throw itself, so a
  // regression names its own cause rather than only its symptom.
  const crashes: string[] = [];
  page.on("pageerror", (e) => crashes.push(e.message));

  // A burst, posted in parallel so the appends land inside one millisecond
  // window. Twelve is comfortably enough: the reviewer measured six collisions
  // in twenty-four sequential posts, and parallel posts collide harder.
  const posted = await page.evaluate(async () => {
    const sent: string[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        // Padded, so no text is a prefix of another - `message 1` would
        // otherwise substring-match `message 10` and the per-text assertion
        // would be measuring the fixture rather than the product.
        const text = `burst message ${String(i).padStart(2, "0")}`;
        sent.push(text);
        return fetch("/__lucid/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: crypto.randomUUID(), text, refs: [], images: [] }),
        });
      }),
    );
    return sent;
  });

  // Every message renders, as its own bubble. Under the collided id the count
  // came up short even when the page survived - two messages sharing an id is
  // one message on screen, which loses the human's words just as completely.
  const bubbles = page.locator('[data-role="human"]');
  await expect(bubbles).toHaveCount(posted.length, { timeout: 20_000 });
  for (const text of posted) await expect(bubbles.filter({ hasText: text })).toHaveCount(1);

  // ...and the viewer is still a viewer.
  expect(crashes, `the viewer threw: ${crashes.join(" | ")}`).toEqual([]);
  await expect(on(page).messageInput()).toBeVisible();
});
