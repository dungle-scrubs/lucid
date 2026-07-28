import { Glob } from "bun";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Two-artifact build (D-034): build the browser bundle (embedded as a string
 * constant), then `bun build --compile` the CLI into a single binary that
 * serves the embedded bundle + Effect server + static assets from inside itself.
 */
const root = resolve(import.meta.dir, "..");

/**
 * `bun build --compile` leaves its intermediate behind - one `.<hash>.bun-build`
 * in the cwd per invocation, each the full size of the binary (~60MB as of Bun
 * 1.3.14). Nothing reaps them and no flag governs it, so they accumulate one per
 * build, invisibly: they are gitignored, so `git status` stays clean while the
 * checkout grows without bound. This sweep is why the repo does not quietly
 * reach gigabytes.
 *
 * It removes every match in the repo root, which assumes one build at a time -
 * true for a local script, and a concurrent build would already be racing over
 * dist/lucid anyway.
 */
const sweepCompileScratch = async (): Promise<number> => {
  let swept = 0;
  for await (const file of new Glob("*.bun-build").scan({
    cwd: root,
    dot: true,
    onlyFiles: true,
  })) {
    await unlink(resolve(root, file)).then(
      () => swept++,
      () => {},
    );
  }
  return swept;
};

console.log("[1/2] building client bundle…");
await import("./build-client.ts");

console.log("[2/2] compiling single binary…");
const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    resolve(root, "src/cli/main.ts"),
    "--outfile",
    // The e2e suite builds its OWN copy here (dist/lucid-e2e). `dist/lucid` is
    // the artifact a human runs - `lucid hub --attend` is a long-lived process
    // executing that exact file - and a test run that rebuilds it overwrites a
    // live executable. Nothing in the suite needs the human's binary, so it
    // does not touch it.
    resolve(root, process.env.LUCID_BINARY_OUT ?? "dist/lucid"),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
// Sweep on failure too: a failed compile leaves its intermediate behind exactly
// like a successful one, and a build that errors in a loop is the fastest way to
// fill a disk.
const swept = await sweepCompileScratch();
if (code !== 0) throw new Error(`bun build --compile failed (exit ${code})`);
console.log(
  `built ${process.env.LUCID_BINARY_OUT ?? "dist/lucid"}${swept > 0 ? ` (swept ${swept} compile intermediate${swept > 1 ? "s" : ""})` : ""}`,
);
