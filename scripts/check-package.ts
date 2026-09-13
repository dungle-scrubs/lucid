/** Exercise a relocated package from an unrelated working folder. */
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const checkPackage = async (packageDir: string): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "lucid package check "));
  const installed = join(root, "installed");
  cpSync(packageDir, installed, { recursive: true });
  const executable = join(root, "lucid");
  symlinkSync(join(installed, "main.js"), executable);
  const preload = join(root, "port.mjs");
  await Bun.write(
    preload,
    `
const serve = Bun.serve.bind(Bun);
const cwd = process.cwd();
Bun.serve = (options) => {
  if (options.hostname !== "127.0.0.1" || options.port !== 17454) {
    throw new Error("Unexpected package listener");
  }
  const server = serve({ ...options, port: 0 });
  if (process.cwd() !== cwd) throw new Error("Package changed the working folder");
  console.log("PACKAGE_URL=" + server.url);
  return server;
};
`,
  );
  const child = Bun.spawn([process.execPath, "--preload", preload, executable, "serve"], {
    cwd: root,
    env: { HOME: root, LUCID_ROOT: join(root, "records"), PATH: dirname(process.execPath) },
    stderr: "pipe",
    stdout: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    let output = "";
    let base: string | undefined;
    while (!base) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Package failed to start: ${await stderr}`);
      output += new TextDecoder().decode(chunk.value);
      base = output.match(/PACKAGE_URL=(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    }
    reader.releaseLock();
    for (const route of [
      "/",
      "/c/package-check",
      "/c/package-check/artifact",
      "/c/package-check/artifact/1",
    ]) {
      const response = await fetch(new URL(route, base));
      const html = await response.text();
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/html") ||
        !html.includes('id="root"')
      ) {
        throw new Error(`Missing or invalid page ${route}`);
      }
      const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)];
      if (assets.length < 2) throw new Error(`Missing page assets ${route}`);
      for (const [, asset] of assets) {
        const url = new URL(asset as string, new URL(route, base));
        const file = await fetch(url);
        const body = await file.text();
        const type = file.headers.get("content-type") ?? "";
        if (
          !file.ok ||
          !body ||
          !type.includes(url.pathname.endsWith(".css") ? "text/css" : "javascript")
        ) {
          throw new Error(`Missing or invalid package asset ${url.pathname}`);
        }
      }
    }
    console.log("package check: relocated CLI serves both pages and their assets");
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    await stderr;
    rmSync(root, { recursive: true, force: true });
  }
};

if (import.meta.main) await checkPackage(resolve("dist/package"));
