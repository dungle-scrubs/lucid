/** Portable Bun package. HTML, scripts, and compiled styles ship together. */
import { chmodSync, rmSync } from "node:fs";
import tailwind from "bun-plugin-tailwind";

const outdir = "dist/package";
rmSync(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  external: ["@dungle-scrubs/harness-cli-normalizer"],
  outdir,
  plugins: [tailwind],
  target: "bun",
  throw: true,
});
for (const log of result.logs) console.warn(String(log));
const styles = (
  await Promise.all(
    result.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text()),
  )
).join("\n");
for (const marker of ["tailwindcss v", ".pane-grip", ".hub-row"]) {
  if (!styles.includes(marker)) throw new Error(`Package styles missing ${marker}`);
}
chmodSync(`${outdir}/main.js`, 0o755);
console.log(`built ${outdir}`);
