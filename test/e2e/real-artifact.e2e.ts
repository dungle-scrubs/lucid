import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { makeCli, surfaceOf, type Cli } from "./helpers.ts";

let cli: Cli | undefined;
test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

const RATIO = `(a, b) => {
  const parse = (s) => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = lum(parse(a)), l2 = lum(parse(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}`;

test.use({ colorScheme: "dark" });

/**
 * A diagnostic, not a gate: point it at any artifact and it reports the worst
 * contrast pairs in both themes, measured in a real browser with translucent
 * layers composited. `PROBE_HTML=/path/to/artifact.html bunx playwright test
 * test/e2e/real-artifact.e2e.ts`
 */
test("the real artifact, measured", async ({ page }) => {
  const probe = process.env.PROBE_HTML;
  test.skip(probe === undefined, "set PROBE_HTML to an artifact to measure it");
  const html = await readFile(probe as string, "utf8");
  cli = await makeCli(html);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  await expect(surface.locator("h1").first()).toBeVisible();

  const sample = async (label: string) => {
    // The EFFECTIVE background: every translucent layer composited over the one
    // behind it, down to an opaque base. Reading only the nearest colour treats
    // `rgba(203,168,90,.18)` as solid brass and invents failures that are not on
    // screen - the wash is 18% over dark paper, not the wash itself.
    const rows = await surface
      .locator("p, li, td, code, h1, h2, h3, .deck, .fact-v")
      .evaluateAll((nodes) =>
        nodes.slice(0, 400).map((n) => {
          const parse = (c: string): [number, number, number, number] => {
            const m = c.match(/[\d.]+/g) ?? ["0", "0", "0", "0"];
            return [
              Number(m[0]),
              Number(m[1]),
              Number(m[2]),
              m[3] === undefined ? 1 : Number(m[3]),
            ];
          };
          const over = (
            fg: [number, number, number, number],
            bg: [number, number, number, number],
          ): [number, number, number, number] => [
            fg[0] * fg[3] + bg[0] * (1 - fg[3]),
            fg[1] * fg[3] + bg[1] * (1 - fg[3]),
            fg[2] * fg[3] + bg[2] * (1 - fg[3]),
            1,
          ];

          const layers: [number, number, number, number][] = [];
          let el: Element | null = n;
          while (el) {
            const c = parse(getComputedStyle(el).backgroundColor);
            if (c[3] > 0) {
              layers.push(c);
              if (c[3] === 1) break; // opaque: nothing behind it shows
            }
            el = el.parentElement;
          }
          // Bottom-up, so each layer lands on what is already composited.
          let bgRgb: [number, number, number, number] = [255, 255, 255, 1];
          for (const layer of layers.reverse()) bgRgb = over(layer, bgRgb);
          const fgRgb = over(parse(getComputedStyle(n).color), bgRgb);
          const fmt = (c: [number, number, number, number]) =>
            `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
          return {
            text: (n.textContent ?? "").trim().slice(0, 30),
            fg: fmt(fgRgb),
            bg: fmt(bgRgb),
            size: getComputedStyle(n).fontSize,
          };
        }),
      );
    const scored = [];
    for (const r of rows) {
      if (r.text === "") continue;
      const ratio = (await page.evaluate(
        `(${RATIO})(${JSON.stringify(r.fg)}, ${JSON.stringify(r.bg)})`,
      )) as number;
      scored.push({ ...r, ratio: Math.round(ratio * 100) / 100 });
    }
    scored.sort((a, b) => a.ratio - b.ratio);
    const worst = scored.slice(0, 6);
    const failing = scored.filter((s) => s.ratio < 4.5).length;
    console.log(`\n=== ${label} === ${scored.length} text nodes, ${failing} below 4.5:1`);
    for (const w of worst) console.log(`  ${w.ratio}  ${w.fg} on ${w.bg}  "${w.text}"`);
    return { failing, total: scored.length, worst: worst[0]?.ratio ?? 0 };
  };

  const light = await sample("LIGHT (OS dark)");
  await page.locator('[data-test="theme-toggle"]').click();
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "dark");
  const dark = await sample("DARK");
  console.log("\nSUMMARY", JSON.stringify({ light, dark }));
});
