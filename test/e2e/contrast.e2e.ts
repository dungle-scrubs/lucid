import { expect, test } from "@playwright/test";
import { makeCli, surfaceOf, type Cli } from "./helpers.ts";

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
  await page.locator('[data-test="theme-toggle"]').click();
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

  await page.locator('[data-test="theme-toggle"]').click();
  // The toggle records the human's choice...
  await expect(page.locator('[data-test="theme-toggle"]')).toHaveAttribute("data-theme", "dark");
  // ...but this document stays in its only form.
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "light");

  const [fg, bg] = await surface
    .locator('[data-lucid-id="h"]')
    .evaluate((n) => [getComputedStyle(n).color, getComputedStyle(document.body).backgroundColor]);
  const ratio = (await page.evaluate(
    `(${RATIO})(${JSON.stringify(fg)}, ${JSON.stringify(bg)})`,
  )) as number;
  expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});
