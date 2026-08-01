import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { on } from "../locators.ts";
import { makeCli, overlaySettled, surfaceOf } from "../helpers.ts";
import type { Cli } from "../helpers.ts";

/**
 * Regression: a live artifact update replaced the document's styles without
 * reapplying Lucid's selected theme. On a dark OS, every fresh
 * `prefers-color-scheme: dark` block immediately matched even while the chrome
 * and artifact root still said light. A dark-to-light toggle repaired those
 * rules only until the next update.
 */
const artifact = (version: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Theme swap</title>
<style>
  :root { --paper:#faf6ec; --ink:#211d15; --surface:#f1ece0; --sunken:#e8e2d4; }
  @media (prefers-color-scheme: dark) {
    :root { --paper:#211d15; --ink:#ece3cf; --surface:#2a251b; --sunken:#191509; }
  }
  body { background:var(--paper); color:var(--ink); }
  section { background:var(--surface); padding:1rem; }
  code { background:var(--sunken); color:var(--ink); }
</style></head><body>
<h1>${version}</h1>
<section>Section <code>inline code</code></section>
</body></html>`;

const LIGHT_ONLY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Light only</title>
<style>body { background:#faf6ec; color:#211d15; }</style>
</head><body><h1>light only</h1></body></html>`;

const LINKED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Linked theme</title>
<link rel="stylesheet" href="tokens.css" />
</head><body><h1>linked theme</h1></body></html>`;

const LINKED_CSS = `:root { --paper:#faf6ec; --ink:#211d15; }
@media (prefers-color-scheme: dark) { :root { --paper:#211d15; --ink:#ece3cf; } }
body { background:var(--paper); color:var(--ink); }`;

test.use({ colorScheme: "dark" });

let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

test("light sections and code stay light through every artifact update", async ({ page }) => {
  cli = await makeCli(artifact("version one"));
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);
  const section = surface.locator("section");
  const code = surface.locator("code");

  await expect(on(page).themeToggle()).toHaveAttribute("data-theme", "light");
  await expect(section).toHaveCSS("background-color", "rgb(241, 236, 224)");
  await expect(code).toHaveCSS("background-color", "rgb(232, 226, 212)");

  await cli.write(artifact("version two"));
  await expect(surface.locator("h1")).toContainText("version two");
  await expect(section).toHaveCSS("background-color", "rgb(241, 236, 224)");
  await expect(code).toHaveCSS("background-color", "rgb(232, 226, 212)");

  await on(page).themeToggle().click();
  await on(page).themeToggle().click();
  await expect(on(page).themeToggle()).toHaveAttribute("data-theme", "light");

  await cli.write(artifact("version three"));
  await expect(surface.locator("h1")).toContainText("version three");
  await expect(section).toHaveCSS("background-color", "rgb(241, 236, 224)");
  await expect(code).toHaveCSS("background-color", "rgb(232, 226, 212)");
});

test("a swapped linked stylesheet adopts the requested theme after it loads", async ({ page }) => {
  cli = await makeCli(LIGHT_ONLY);
  await writeFile(join(cli.dir, "tokens.css"), LINKED_CSS);
  const opened = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(opened.url);
  const surface = surfaceOf(page);

  await on(page).themeToggle().click();
  await overlaySettled(page);
  await expect(on(page).themeToggle()).toHaveAttribute("data-theme", "dark");
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "light");

  let releaseStylesheet: (() => void) | undefined;
  const stylesheetBlocked = new Promise<void>((resolve) => {
    releaseStylesheet = resolve;
  });
  await page.route("**/tokens.css", async (route) => {
    await stylesheetBlocked;
    await route.continue();
  });

  await cli.write(LINKED);
  await expect(surface.locator("h1")).toContainText("linked theme");
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "light");

  releaseStylesheet?.();
  await expect(surface.locator("html")).toHaveAttribute("data-lucid-theme", "dark");
  await expect(surface.locator("body")).toHaveCSS("background-color", "rgb(33, 29, 21)");
});
