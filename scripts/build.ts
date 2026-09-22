/**
 * Build the `lucid` binary.
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

const OUTFILE = "dist/lucid";

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
  for (const shell of ["reader", "hub"]) {
    const script = bytes.match(
      new RegExp(`<script id="lucid-theme-bootstrap-${shell}">([\\s\\S]*?)</script>`),
    )?.[1];
    if (
      !script?.includes('localStorage.getItem("lucid.theme.v1")') ||
      !script.includes("style.colorScheme")
    ) {
      throw new Error(`${OUTFILE} is missing the ${shell} prepaint appearance bootstrap.`);
    }
  }
  if (!bytes.includes(COMPILED_MARKER)) {
    throw new Error(
      `${OUTFILE} carries no compiled Tailwind. The plugin did not run, and the binary would serve a stylesheet with no utilities and no theme in it.`,
    );
  }
  if (!bytes.includes(APP_MARKER) || !bytes.includes(".hub-row")) {
    throw new Error(
      `${OUTFILE} is missing the artifact or hub stylesheet. Both browser surfaces must reach the binary.`,
    );
  }
};

await verifyTailwindCompiled();

/** Ad-hoc sign the binary on macOS.
 *
 * This is the second silent failure the script exists to prevent, and it is
 * the reason the plugin requirement above costs more than it looks like it
 * costs. `bun build --compile` signs its macOS output. `Bun.build`'s compile
 * API does not, so the binary keeps the signature of the Bun runtime it was
 * appended to, and that signature no longer matches the bytes.
 *
 * On arm64 the kernel refuses to exec a Mach-O whose signature is invalid. It
 * sends SIGKILL before any code runs: exit 137, no stderr, no crash report.
 * A caller that reads exit codes reports "failed with no output", which points
 * at the caller rather than at the binary. Agent harnesses run `lucid` as a
 * hook, so an unsigned build reads there as a broken hook on every tool call.
 */
const signBinary = () => {
  if (process.platform !== "darwin") return;
  const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", OUTFILE]);
  if (!sign.success) {
    throw new Error(
      `codesign failed on ${OUTFILE}: ${sign.stderr.toString().trim()}\nAn unsigned arm64 binary is SIGKILLed on exec.`,
    );
  }
  const verify = Bun.spawnSync(["codesign", "--verify", OUTFILE]);
  if (!verify.success) {
    throw new Error(
      `${OUTFILE} still carries an invalid signature after codesign: ${verify.stderr.toString().trim()}`,
    );
  }
};

signBinary();

/** Exec the binary once. The signature checks above prove the kernel will
 * load it; this proves the embedded bundle actually starts. */
const version = Bun.spawnSync([OUTFILE, "--version"]);
if (!version.success) {
  throw new Error(
    `${OUTFILE} does not run: exit ${version.exitCode}, stderr ${version.stderr.toString().trim() || "(empty)"}`,
  );
}

// `--compile` leaves a scratch file beside the entrypoint.
for (const f of new Bun.Glob(".*.bun-build").scanSync(".")) rmSync(f, { force: true });

console.log(`built ${OUTFILE} (${version.stdout.toString().trim()})`);
