import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

/**
 * The UI dev loop: `bun run dev`.
 *
 * Production Lucid embeds the browser bundles in the binary (D-034), which
 * makes UI iteration a rebuild-and-restart cycle. This loop removes that:
 *
 * 1. builds the client bundles to dist/ (the same build-client.ts),
 * 2. starts a hub with LUCID_DEV_ASSETS=dist, so chrome.js/chrome.css/
 *    client.js are served fresh from disk on every request,
 * 3. watches client/ and src/ and rebuilds on change - the hub's listing
 *    stream carries a bundle stamp, so every connected shell reloads itself.
 *
 * Edit, save, watch the window refresh. Live reload, not HMR: component
 * state resets on reload (true Fast Refresh would mean a Vite dev server,
 * which this bun-only repo has deliberately not adopted). Honors
 * LUCID_HUB_PORT; Ctrl-C stops both the watcher and the hub.
 */
const root = resolve(import.meta.dir, "..");

const build = (): Promise<number> =>
  new Promise((done) => {
    const child = spawn("bun", ["run", resolve(root, "scripts/build-client.ts")], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("exit", (code) => done(code ?? 1));
  });

console.log("dev: initial client build…");
if ((await build()) !== 0) {
  console.error("dev: initial build failed - fix it and rerun");
  process.exit(1);
}

const hub = spawn("bun", ["run", resolve(root, "src/cli/main.ts"), "hub"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, LUCID_DEV_ASSETS: resolve(root, "dist") },
});
hub.once("exit", (code) => {
  console.error(`dev: hub exited (${code})`);
  process.exit(code ?? 1);
});

let building = false;
let queued = false;
let debounce: ReturnType<typeof setTimeout> | undefined;

const rebuild = async (): Promise<void> => {
  if (building) {
    queued = true; // a save landed mid-build; run once more after
    return;
  }
  building = true;
  try {
    const code = await build();
    console.log(code === 0 ? "dev: rebuilt - shells reload themselves" : "dev: build failed");
  } finally {
    building = false;
    if (queued) {
      queued = false;
      void rebuild();
    }
  }
};

const onChange = (file: string | null): void => {
  // The build's own outputs must not retrigger it.
  if (file && (file.startsWith("dist/") || file.includes("client-bundle.generated"))) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void rebuild(), 150);
};

for (const dir of ["client", "src", "assets"]) {
  watch(resolve(root, dir), { recursive: true }, (_event, file) => onChange(file));
}
console.log("dev: watching client/, src/, assets/ - Ctrl-C to stop");

process.once("SIGINT", () => {
  hub.kill("SIGTERM");
  process.exit(0);
});
