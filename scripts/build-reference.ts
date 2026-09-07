/**
 * Build the behaviour reference into one self-contained HTML file.
 *
 * Self-contained is the requirement, not a convenience. The reference goes
 * to a design tool that has no access to this repository - Claude Design,
 * pen.dev, or a person with a browser - so every byte it needs has to be
 * inside the file. `--compile --target=browser` inlines the JavaScript, the
 * CSS and any assets into the HTML.
 *
 * Same plugin discipline as `scripts/build.ts`, and for the same reason:
 * bundler plugins do not run through the `bun build` CLI, so a command line
 * would emit the raw `@import "tailwindcss"` and succeed.
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import tailwind from "bun-plugin-tailwind";

const OUTDIR = "dist";
const OUTFILE = `${OUTDIR}/behaviour-reference.html`;

mkdirSync(OUTDIR, { recursive: true });

/* `compile: true` with a browser target is what makes one file instead of
 * an HTML plus its chunks. Without it the build succeeds and emits a page
 * that breaks the moment it is moved. */
const result = await Bun.build({
  entrypoints: ["src/server/client/reference.html"],
  outdir: OUTDIR,
  target: "browser",
  compile: true,
  minify: false,
  plugins: [tailwind],
  throw: true,
});

// Named for what it is rather than for its entrypoint.
renameSync(`${OUTDIR}/reference.html`, OUTFILE);

for (const log of result.logs) console.warn(String(log));

/** Confirm the file stands on its own.
 *
 * Checked against the artifact, because a build that failed to inline
 * something still reports success and only fails later, on a machine that
 * cannot reach this repository. */
const verify = async (): Promise<void> => {
  const html = await Bun.file(OUTFILE).text();
  if (!html.includes("tailwindcss v")) {
    throw new Error(`${OUTFILE} carries no compiled Tailwind: the plugin did not run.`);
  }
  // A `src` or `href` pointing at a sibling file is exactly what "self
  // contained" rules out.
  const external = [...html.matchAll(/\b(?:src|href)="(?!data:|#|https?:)([^"]+)"/g)].map(
    (m) => m[1],
  );
  if (external.length > 0) {
    throw new Error(
      `${OUTFILE} still references ${external.length} external file(s): ${external.join(", ")}. It would break the moment it left this directory.`,
    );
  }
  // The states themselves. If the injected stylesheet did not make it in,
  // the in-document cases render as plain text and the page is a lie.
  for (const needed of [
    "lucid-noted",
    "lucid-range",
    "note-card",
    "doc-waiting",
    "input-recovery",
    "empty-panel",
  ]) {
    if (!html.includes(needed)) throw new Error(`${OUTFILE} is missing ${needed}.`);
  }
  const kb = Math.round((await Bun.file(OUTFILE).arrayBuffer()).byteLength / 1024);
  console.log(`built ${OUTFILE} (${kb} KB, self-contained)`);
};

await verify();

for (const f of new Bun.Glob(".*.bun-build").scanSync(".")) rmSync(f, { force: true });
