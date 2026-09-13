/** Portable Bun package. HTML, scripts, and compiled styles ship together. */
import { chmodSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { checkPackage } from "./check-package.js";

const outdir = "dist/package";
rmSync(outdir, { recursive: true, force: true });
const browser = await Bun.build({
  entrypoints: ["src/server/client/hub.html", "src/server/client/index.html"],
  outdir,
  plugins: [tailwind],
  publicPath: "/",
  target: "browser",
  throw: true,
});
for (const log of browser.logs) console.warn(String(log));
const styles = (
  await Promise.all(
    browser.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text()),
  )
).join("\n");
for (const marker of ["tailwindcss v", ".pane-grip", ".hub-row"]) {
  if (!styles.includes(marker)) throw new Error(`Package styles missing ${marker}`);
}

// Bun's portable HTML manifests resolve files against cwd. Generate standard
// Response routes instead, with file URLs relative to the installed entrypoint.
const pages: Record<string, string> = {};
const assets: string[] = [];
for (const output of browser.outputs) {
  const path = relative(resolve(outdir), output.path);
  const response = `new Response(Bun.file(new URL(${JSON.stringify(`./${path}`)}, import.meta.url)), { headers: { "content-type": ${JSON.stringify(output.type)} } })`;
  if (path === "hub.html" || path === "index.html") {
    pages[path] = response;
  } else {
    assets.push(`${JSON.stringify(`/${path}`)}: ${response}`);
  }
}
if (!pages["hub.html"] || !pages["index.html"]) throw new Error("Missing package browser pages");
const result = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  external: ["@dungle-scrubs/harness-cli-normalizer"],
  outdir,
  plugins: [
    {
      name: "portable-browser-pages",
      setup(build) {
        build.onLoad({ filter: /\/server\/browser-pages\.ts$/ }, () => ({
          contents: `export const browserPages = { assets: { ${assets.join(",")} }, hub: ${pages["hub.html"]}, index: ${pages["index.html"]} };`,
          loader: "js",
        }));
      },
    },
  ],
  target: "bun",
  throw: true,
});
for (const log of result.logs) console.warn(String(log));
chmodSync(`${outdir}/main.js`, 0o755);
await checkPackage(resolve(outdir));
console.log(`built ${outdir}`);
