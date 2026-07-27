// A real `lucid hub`, isolated from the one you are running.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { invoke, makeCli, MAIN, type Cli } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";

/**
 * A real `lucid hub` on an ephemeral port with an isolated registry - the shell
 * (Model B) as the human runs it. Shared by every suite that drives the shell,
 * so the harness has one definition rather than a copy per file.
 */
export interface Hub {
  readonly port: number;
  readonly url: string;
  /** The hub's isolated state dir, which is also its only scan root. */
  readonly dir: string;
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

export interface HubOptions {
  /** Run the attend engine, so `/hub/create` spawns instead of answering 403. */
  readonly attend?: boolean;
  /** A harness registry for this hub alone, written into the hub's dir and
   *  pointed at by LUCID_HARNESSES - the user's own
   *  `~/.config/lucid/harnesses.json` is never read by these tests. */
  readonly harnesses?: unknown;
}

export const startHub = async (options: HubOptions = {}): Promise<Hub> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-hub-e2e-"));
  if (options.harnesses !== undefined) {
    // The path `harnessEnv` already points LUCID_HARNESSES at; writing the file
    // is what turns it from "isolated and absent" into "isolated and stocked".
    await writeFile(join(dir, "harnesses.json"), JSON.stringify(options.harnesses, null, 2));
  }
  const env = {
    ...harnessEnv(dir),
    // No scan of the real ~/dev: the isolated registry is the only source.
    LUCID_HUB_ROOTS: dir,
  };
  const child: ChildProcess = spawn(
    "bun",
    ["run", MAIN, "hub", "--port", "0", ...(options.attend ? ["--attend"] : [])],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  /**
   * Every way this can fail leaves the process dead and the directory gone.
   *
   * A hub that never announced its port is still a running `bun` holding a
   * registry, and the temp dir it was given outlives the test either way. The
   * timeout path used to leak both: the suite moved on, `globalTeardown` reaped
   * the process at the END of the run and reported it, and the directory stayed
   * until somebody swept /tmp. SIGKILL rather than SIGTERM, because a hub that
   * did not manage to print a line is not owed a graceful shutdown.
   */
  const abandon = async (): Promise<void> => {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      void abandon().finally(() => reject(new Error("hub did not start within 15s")));
    }, 15_000);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(Number.parseInt(m[1], 10));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // Already dead, so only the directory is left to take with it.
      void rm(dir, { recursive: true, force: true }).finally(() =>
        reject(new Error(`hub exited early (${code}): ${buf}`)),
      );
    });
  });
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    dir,
    env: { ...env, LUCID_HUB_PORT: String(port) },
    // The temp dir dies with the hub that owns it: a test that stops the hub is
    // done with its registry, and a leftover dir is a ghost session in someone
    // else's listing.
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/** `lucid open` against the hub: a CLI whose env routes discovery at it. */
export const openIntoHub = async (
  hub: Hub,
  html: string,
): Promise<{ cli: Cli; shellUrl: string }> => {
  const c = await makeCli(html);
  // Rebind the CLI's env to the hub (makeCli's own env has no LUCID_HUB_PORT).
  const run = async (args: string[], timeoutMs = 30_000) =>
    invoke(args, {
      cwd: c.dir,
      timeout: timeoutMs,
      env: { ...hub.env, LUCID_IDLE_MS: "0" },
    });
  const opened = (await run(["open", c.artifact])) as { url: string };
  expect(opened.url).toContain(`127.0.0.1:${hub.port}/?s=`);
  return { cli: { ...c, run } as Cli, shellUrl: opened.url };
};
