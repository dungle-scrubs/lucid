import { on } from "./locators.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { makeCli, overlaySettled, surfaceOf, type Cli } from "./helpers.ts";

let cli: Cli | undefined;
test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

/** WCAG relative luminance + contrast ratio, from a computed rgb() string. */
const RATIO = `(a, b) => {
  const parse = (s) => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = lum(parse(a)), l2 = lum(parse(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}`;

// The shape that broke: a dozen tokens remapped inside prefers-color-scheme,
// only six of which Lucid injects. On a dark machine the other six kept their
// dark values under light paper - pale grey body text, dark code chips.
const ARTIFACT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Contrast probe</title>
<style>
  :root {
    --paper:#faf6ec; --ink:#211d15; --ink-muted:#5e6773; --rule:rgba(33,29,21,.12);
    --accent:#7b6228; --accent-wash:rgba(203,168,90,.16);
    --muted:#5e6773; --faint:#6b6558; --surface:#f1ece0; --sunken:#e8e2d4; --ink-soft:#3a352b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper:#211d15; --ink:#ece3cf; --ink-muted:#a89d84; --rule:rgba(236,227,207,.14);
      --accent:#d9bd7a; --accent-wash:rgba(203,168,90,.18);
      --muted:#8f8878; --faint:#a89d84; --surface:#2a251b; --sunken:#191509; --ink-soft:#cfc6ae;
    }
  }
  body { background: var(--paper); color: var(--ink); font-family: system-ui; margin: 40px; }
  .deck { color: var(--muted); }
  .faint { color: var(--faint); }
  .soft { color: var(--ink-soft); }
  code { background: var(--sunken); color: var(--ink); padding: 2px 6px; }
</style></head>
<body>
  <h1 data-lucid-id="title">Contrast probe</h1>
  <p class="deck" data-lucid-id="deck">Deck text through --muted.</p>
  <p class="faint" data-lucid-id="faint">Caption text through --faint.</p>
  <p class="soft" data-lucid-id="soft">Body text through --ink-soft.</p>
  <p><code data-lucid-id="chip">a code chip</code></p>
</body></html>`;

// The machine is in DARK mode - the case that produced the unreadable page.
test.use({ colorScheme: "dark" });

test("every text token stays legible in BOTH themes on a dark machine", async ({ page }) => {
  cli = await makeCli(ARTIFACT);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1")).toBeVisible();

  const IDS = ["title", "deck", "faint", "soft", "chip"];
  const measure = async () =>
    Object.fromEntries(
      await Promise.all(
        IDS.map(async (id) => {
          const el = surface.locator(`[data-lucid-id="${id}"]`);
          const [fg, bg] = await el.evaluate((node) => {
            const s = getComputedStyle(node);
            let bgEl: Element | null = node;
            let bg = "rgba(0, 0, 0, 0)";
            while (bgEl) {
              const c = getComputedStyle(bgEl).backgroundColor;
              if (c && !c.includes("rgba(0, 0, 0, 0)")) {
                bg = c;
                break;
              }
              bgEl = bgEl.parentElement;
            }
            return [s.color, bg];
          });
          const ratio = await page.evaluate(
            `(${RATIO})(${JSON.stringify(fg)}, ${JSON.stringify(bg)})`,
          );
          return [id, { fg, bg, ratio: Math.round((ratio as number) * 100) / 100 }];
        }),
      ),
    );

  const light = (await measure()) as Record<string, { fg: string; bg: string; ratio: number }>;
  console.log("LIGHT (OS is dark):", JSON.stringify(light, null, 1));
  await on(page).themeToggle().click();
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "dark");
  const dark = (await measure()) as Record<string, { fg: string; bg: string; ratio: number }>;
  console.log("DARK:", JSON.stringify(dark, null, 1));

  // WCAG AA for body text. Measured, not assumed.
  for (const [id, m] of Object.entries(light)) {
    expect(m.ratio, `light/${id} ${m.fg} on ${m.bg}`).toBeGreaterThanOrEqual(4.5);
  }
  for (const [id, m] of Object.entries(dark)) {
    expect(m.ratio, `dark/${id} ${m.fg} on ${m.bg}`).toBeGreaterThanOrEqual(4.5);
  }
});

// An artifact with no tokens and no dark block: hardcoded ink on hardcoded
// paper, exactly what a hand-written or recovered document looks like.
const PLAIN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Plain</title>
<style>
  body { background: #faf6ec; color: #211d15; font-family: system-ui; margin: 40px; }
  h2 { color: #3a352b; }
</style></head>
<body><h2 data-lucid-id="h">Where to go deeper</h2>
<p data-lucid-id="p">follow one publish end to end.</p></body></html>`;

test("an artifact with no dark form is left in the one it has", async ({ page }) => {
  // Forcing dark on it flips the browser's canvas to near-black while its own
  // hardcoded ink stays dark - dark text on a dark ground, worse than the light
  // page the author actually designed.
  cli = await makeCli(PLAIN);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h2")).toBeVisible();

  await on(page).themeToggle().click();
  // The toggle records the human's choice...
  await expect(on(page).themeToggle()).toHaveAttribute("data-theme", "dark");
  // ...but this document stays in its only form.
  //
  // Settled first, then read once. A correct implementation produces NO change
  // here, so there is no transition for a polling assertion to wait on - it would
  // resolve against the attribute that was already there and pass before the
  // overlay had read the message at all. That is exactly how this test was green
  // on a laptop while the behaviour was broken on every platform.
  await overlaySettled(page);
  expect(await surface.locator("html").getAttribute("data-lucid-theme")).toBe("light");

  const [fg, bg] = await surface
    .locator('[data-lucid-id="h"]')
    .evaluate((n) => [getComputedStyle(n).color, getComputedStyle(document.body).backgroundColor]);
  const ratio = (await page.evaluate(
    `(${RATIO})(${JSON.stringify(fg)}, ${JSON.stringify(bg)})`,
  )) as number;
  expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

// A dark form carried entirely by the artifact's OWN media block, with no tokens
// anywhere. Lucid reaches this one by rewriting the query, never by injecting
// values - so it is the case that proves the rewrite stays reversible.
const OWN_DARK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Own dark</title>
<style>
  body { background: #faf6ec; color: #211d15; font-family: system-ui; margin: 40px; }
  @media (prefers-color-scheme: dark) {
    body { background: #211d15; color: #ece3cf; }
  }
</style></head>
<body><h2 data-lucid-id="h">Where to go deeper</h2></body></html>`;

test("an artifact whose dark form is its own media block follows every toggle", async ({
  page,
}) => {
  cli = await makeCli(OWN_DARK);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  const root = surface.locator("html");
  await expect(surface.locator("h2")).toBeVisible();

  const toggle = on(page).themeToggle();
  await toggle.click();
  await expect(root).toHaveAttribute("data-lucid-theme", "dark");
  await toggle.click();
  await expect(root).toHaveAttribute("data-lucid-theme", "light");

  // Every one of these depends on the same thing, including the first. Applying
  // a theme REWRITES the artifact's `prefers-color-scheme` conditions to
  // `(min-width: 0px)` / `(max-width: 0px)`, and the chrome sends a theme
  // message as soon as the overlay is ready - so by the time a human can click
  // anything, no rule in the document mentions prefers-color-scheme at all.
  // Asking the live condition whether this artifact has a dark form would say
  // no, from the very first toggle. Only the original conditions, kept aside
  // before the first rewrite, still answer truthfully. The round trip is here
  // to prove the answer survives being toggled back and forth, not because the
  // third click is special.
  await toggle.click();
  await expect(root).toHaveAttribute("data-lucid-theme", "dark");
  // Its own block is genuinely in force, not merely the attribute.
  await expect(surface.locator("body")).toHaveCSS("background-color", "rgb(33, 29, 21)");
});

// An artifact that routes its colour through the tokens Lucid remaps but never
// mentions --paper or --ink, and ships no dark block of its own: its whole dark
// form is Lucid's remap.
const REMAPPED_ONLY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Remapped</title>
<style>
  :root { --accent:#7b6228; --ink-muted:#5e6773; --rule:rgba(33,29,21,.12); }
  body { background: var(--paper); color: var(--ink); font-family: system-ui; margin: 40px; }
  h2 { color: var(--accent); border-bottom: 1px solid var(--rule); }
  p { color: var(--ink-muted); }
</style></head>
<body><h2 data-lucid-id="h">Where to go deeper</h2>
<p data-lucid-id="p">follow one publish end to end.</p></body></html>`;

test("an artifact whose dark form IS Lucid's remap follows the toggle", async ({ page }) => {
  // The capability probe asked whether --paper or --ink resolved, and this
  // document declares neither: it takes both from Lucid and routes the rest of
  // its colour through --accent, --rule and --ink-muted. Two of the six is not
  // the question - any of them means the remap reaches this document.
  cli = await makeCli(REMAPPED_ONLY);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h2")).toBeVisible();
  // Its colours really do come from Lucid's light block, or the assertion below
  // would be measuring a document with no ground at all.
  await expect(surface.locator("body")).toHaveCSS("background-color", "rgb(250, 246, 236)");

  await on(page).themeToggle().click();
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "dark");
  await expect(surface.locator("body")).toHaveCSS("background-color", "rgb(33, 29, 21)");
  await expect(surface.locator("p")).toHaveCSS("color", "rgb(168, 157, 132)");
});

// Tokens in a LINKED sheet - the ordinary shape for anything bigger than a
// one-page document, and the case that cannot be answered by reading rules.
const LINKED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Linked</title>
<link rel="stylesheet" href="tokens.css" /></head>
<body><h2 data-lucid-id="h">Where to go deeper</h2></body></html>`;

const LINKED_CSS = `:root { --paper: #faf6ec; --ink: #211d15; }
@media (prefers-color-scheme: dark) { :root { --paper: #211d15; --ink: #ece3cf; } }
body { background: var(--paper); color: var(--ink); font-family: system-ui; margin: 40px }`;

test("an artifact whose tokens live in a linked sheet still follows the toggle", async ({
  page,
}) => {
  // The surface iframe is sandboxed WITHOUT allow-same-origin, so the artifact
  // runs on an opaque origin - which is cross-origin with the very server that
  // served it. Reading `cssRules` off any <link>ed sheet throws SecurityError,
  // so a capability check that walks rules concludes "no tokens here" for every
  // artifact that keeps its CSS in a file, and pins it light forever. The tokens
  // resolve perfectly well; they are just not readable rule by rule. Asking the
  // computed cascade is the only thing that sees them.
  cli = await makeCli(LINKED);
  await writeFile(join(cli.dir, "tokens.css"), LINKED_CSS);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h2")).toBeVisible();
  // The sheet really did load and its tokens really do resolve - otherwise the
  // assertion below would be measuring a document with no styling at all.
  await expect(surface.locator("body")).toHaveCSS("background-color", "rgb(250, 246, 236)");

  await on(page).themeToggle().click();
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "dark");
  await expect(surface.locator("body")).toHaveCSS("background-color", "rgb(33, 29, 21)");
});
