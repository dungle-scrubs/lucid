import { resolve } from "node:path";

/**
 * Two-artifact build (D-034): build the browser bundle (embedded as a string
 * constant), then `bun build --compile` the CLI into a single binary that
 * serves the embedded bundle + Effect server + static assets from inside itself.
 */
const root = resolve(import.meta.dir, "..");

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
    resolve(root, "dist/lucid"),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code !== 0) throw new Error(`bun build --compile failed (exit ${code})`);
console.log("built dist/lucid");
