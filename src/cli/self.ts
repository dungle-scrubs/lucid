import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import type { SessionPaths } from "../core/paths.ts";
import { discoverLiveServer, type IdentityResponse } from "../server/discovery.ts";

/**
 * How to re-invoke this same CLI as a child process. In dev (`bun run
 * src/cli/main.ts`) argv[1] is the entry script; in the compiled binary it is
 * the first user arg, so there is no script to forward.
 */
export const selfInvocation = (): {
  readonly command: string;
  readonly prefix: readonly string[];
} => {
  const execPath = process.execPath;
  const arg1 = process.argv[1];
  if (arg1 && (arg1.endsWith(".ts") || arg1.endsWith(".js"))) {
    return { command: execPath, prefix: [arg1] };
  }
  return { command: execPath, prefix: [] };
};

/** Spawn the detached per-session server (`__serve`) that outlives this process. */
export const spawnServer = (paths: SessionPaths): void => {
  const { command, prefix } = selfInvocation();
  const out = openSync(paths.serverLog, "a");
  const child = spawn(command, [...prefix, "__serve", paths.artifactPath], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the handshake until the per-session server answers, or time out. */
export const waitForServer = async (
  paths: SessionPaths,
  timeoutMs: number,
): Promise<IdentityResponse | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const identity = await discoverLiveServer(paths);
    if (identity) return identity;
    if (Date.now() > deadline) return undefined;
    await sleep(100);
  }
};

/** Open the system browser to a URL (best-effort, detached). Skipped if LUCID_NO_OPEN. */
export const openBrowser = (url: string): void => {
  if (process.env.LUCID_NO_OPEN === "1") return;
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // best-effort; the URL is also printed for manual opening
  }
};
