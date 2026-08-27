/**
 * Build the `lucid2` binary.
 *
 * This is a script rather than a `bun build` command line for one reason:
 * bundler plugins do not run through the `bun build` CLI. They run through
 * `Bun.build`'s API, or through `bunfig.toml` for the frontend dev server,
 * and nowhere else.
 *
 * That matters because the browser surface's stylesheet starts with
 * `@import "tailwindcss"`. Without the plugin, Bun's CSS parser follows that
 * import into the package, warns `invalid @ rule encountered: '@theme'`, and
 * emits the raw import into the binary. The build still succeeds. The binary
 * still runs. It just serves a stylesheet with no Tailwind in it, and the
 * only sign is a warning nobody reads.
 *
 * So the failure this script exists to prevent is a silent one, and
 * `verifyTailwindCompiled` below turns it into a loud one.
 */

import { rmSync } from "node:fs";
import tailwind from "bun-plugin-tailwind";

const OUTFILE = "dist/lucid2";

/* What the binary is checked for. Both must be present.
 *
 * Not checked: a raw `@import "tailwindcss"` left in the binary. That reads
 * as the obvious failure signal and is not one - `--compile` embeds the Bun
 * runtime, and the runtime carries `bun init` project templates whose own
 * stylesheets contain that exact line. Four of them, in a binary whose CSS
 * compiled correctly. */

/** Tailwind's output banner, emitted once per compiled stylesheet. A build
 * without the plugin carries none. */
const COMPILED_MARKER = "tailwindcss v";
/** A selector only this project's stylesheet defines, so the check covers
 * the whole sheet rather than just the part Tailwind generated. */
const APP_MARKER = ".pane-grip";

const result = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  compile: { outfile: OUTFILE },
  plugins: [tailwind],
  throw: true,
});

for (const log of result.logs) console.warn(String(log));

/** Read the binary back and confirm the stylesheet was compiled.
 *
 * Checked against the artifact rather than the build result, because the
 * build result reports success in both cases. */
const verifyTailwindCompiled = async () => {
  const bytes = await Bun.file(OUTFILE).text();
  if (!bytes.includes(COMPILED_MARKER)) {
    throw new Error(
      `${OUTFILE} carries no compiled Tailwind. The plugin did not run, and the binary would serve a stylesheet with no utilities and no theme in it.`,
    );
  }
  if (!bytes.includes(APP_MARKER)) {
    throw new Error(
      `${OUTFILE} carries no ${APP_MARKER}. The browser surface's own stylesheet did not reach the binary.`,
    );
  }
};

await verifyTailwindCompiled();

// `--compile` leaves a scratch file beside the entrypoint.
for (const f of new Bun.Glob(".*.bun-build").scanSync(".")) rmSync(f, { force: true });

console.log(`built ${OUTFILE}`);
