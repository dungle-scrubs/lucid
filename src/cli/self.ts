import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import type { SessionPaths } from "../core/paths.ts";
import {
  discoverLiveServer,
  type IdentityResponse,
  readServerDescriptor,
  removeServerDescriptor,
} from "../server/discovery.ts";

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

/**
 * Stop a running per-session daemon by the pid in its descriptor, then wait for
 * its handshake to go dark. Used by `open --restart` to replace a live server
 * (e.g. after a rebuild) without ending the session: the log and folded state
 * are untouched - only the process, and the client bundle it loaded at start,
 * are replaced. Returns whether a live server was actually stopped.
 */
export const stopServer = async (paths: SessionPaths, timeoutMs = 5000): Promise<boolean> => {
  const descriptor = await readServerDescriptor(paths);
  if (!descriptor || !(await discoverLiveServer(paths))) return false; // nothing live to stop
  // A descriptor with a base belongs to the shared hub daemon, which hosts
  // OTHER sessions too - killing that pid would take down every one of them.
  // Restarting the hub is `lucid hub`'s own concern, not `open --restart`'s.
  if (descriptor.base) return false;
  const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(descriptor.pid, signal);
    } catch {
      // already gone, or not our process to signal
    }
  };
  kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Liveness is the handshake, never pid existence: a reused pid would read as
    // alive forever. Once the port stops answering, the daemon is truly down.
    if (!(await discoverLiveServer(paths))) break;
    if (Date.now() > deadline) {
      kill("SIGKILL"); // SIGTERM did not take; force it
      break;
    }
    await sleep(100);
  }
  await removeServerDescriptor(paths); // the daemon installs no signal handler, so clear its mark here
  return true;
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
