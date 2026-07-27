import { expect, test } from "@playwright/test";
import { makeCli, overlaySettled, surfaceOf, type Cli } from "../helpers.ts";

/**
 * Regression: `569d43c` - an artifact with no dark form is left in the one it
 * has.
 *
 * Forcing `data-lucid-theme="dark"` onto a document that never declared dark
 * tokens gives dark text on a dark ground: the artifact is not restyled, only
 * relabelled, and the reader gets an unreadable page. An artifact that cannot
 * render dark stays light however the viewer is set.
 *
 * The revert conflicts on this tree - the fix was reimplemented in `617f7db`,
 * where `canRenderDark()` reads the resolved cascade with Lucid's own token
 * block un-matched (D-031, D-032) - so the mutation is a named edit (D-046):
 * make `canRenderDark()` in `client/overlay/overlay.ts` return `true`
 * unconditionally, which is what the original defect amounted to.
 */

/** The control: this one DOES declare a dark form, so it must follow the
 *  toggle. Without it, a theme message that never arrives at all is
 *  indistinguishable from one correctly declined - and deleting the broadcast
 *  entirely left the negative assertion below green. */
const HAS_DARK = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Both forms</title>
<style>
  :root { --paper: #ffffff; --ink: #111111; }
  @media (prefers-color-scheme: dark) { :root { --paper: #111111; --ink: #f5f5f5; } }
  body { background: var(--paper); color: var(--ink); }
</style>
</head>
<body><h1>Both forms</h1></body>
</html>`;

/** No dark form anywhere: no media query, no tokens, no colour-scheme. */
const LIGHT_ONLY = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Light only</title>
<style>body { background: #ffffff; color: #111111; }</style>
</head>
<body><h1>Light only</h1><p>This document declares no dark form at all.</p></body>
</html>`;

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

test("an artifact that declares a dark form does follow the toggle", async ({ page }) => {
  // The control for the test below. If this one stops going dark, the theme
  // message is not arriving at all and the negative assertion proves nothing.
  cli = await makeCli(HAS_DARK);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Both forms");

  await page.locator('[data-test="theme-toggle"]').click();
  await overlaySettled(page);
  expect(await surfaceOf(page).locator("html").getAttribute("data-lucid-theme")).toBe("dark");
});

test("an artifact with no dark form is not relabelled dark", async ({ page }) => {
  cli = await makeCli(LIGHT_ONLY);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toContainText("Light only");

  // Ask for dark, which is the gesture that used to ruin the page.
  await page.locator('[data-test="theme-toggle"]').click();

  // The toggle records the human's choice, whatever the artifact can honour.
  await expect(page.locator('[data-test="theme-toggle"]')).toHaveAttribute("data-theme", "dark");

  // Settled first, then read ONCE. A correct implementation produces no change
  // here, so there is no transition for a polling assertion to wait on: it
  // would resolve against the attribute that was already there and pass before
  // the overlay had read the message at all. That is exactly how the original
  // version of this assertion was green while the behaviour was broken.
  await overlaySettled(page);
  const applied = await surface.locator("html").getAttribute("data-lucid-theme");
  expect(
    applied,
    `the artifact was labelled ${applied} despite declaring no dark form - ` +
      "dark text on a dark ground",
  ).not.toBe("dark");
});
