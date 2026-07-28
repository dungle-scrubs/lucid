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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hubPort, portBase } from "../../src/server/ports.ts";
import { invoke, makeCli, MAIN, type Cli } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";

const execFileAsync = promisify(execFile);

/**
 * How far the harness's FIXED-port hubs sit above the product's own numbers.
 *
 * `hubPort(portBase(env))` alone is 17428 on slot 0 - the exact port the human's
 * `lucid hub` is on while they work, which is measurably true on this machine
 * right now. A suite that binds it either fails to start or, worse, is answered
 * by their hub. So the offset is added to the BASE rather than to the port: the
 * per-slot stride (20) is preserved, so slot N's fixed hub still cannot meet
 * slot N+1's, and 100 is wide enough that no slot can land back on a default.
 */
const FIXED_HUB_BASE_OFFSET = 100;

/**
 * A fixed hub port this worker owns, for the scenarios that must restart a hub
 * on the SAME port (reattach, self-recovery). Derived from `portBase`/`hubPort`
 * rather than written down, so it moves with the suite's isolation instead of
 * drifting away from it.
 */
export const fixedHubPort = (env: NodeJS.ProcessEnv = process.env): number =>
  hubPort(portBase(env) + FIXED_HUB_BASE_OFFSET);

/**
 * Stop whatever is listening on a harness hub port, and wait for the port to go
 * quiet.
 *
 * For hubs the PRODUCT started rather than the harness: `lucid app` spawns its
 * own detached hub, which carries neither of the two signatures
 * `gate.ts survivingProcesses` recognizes (no `lucid-e2e-` path, not `--port
 * 0`), so the global teardown will not reap it. A test that runs `app` owns the
 * hub it caused, and this is how it gives it back.
 */
export const killHubOnPort = async (port: number): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const pids = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).then(
      ({ stdout }) =>
        stdout
          .split("\n")
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isFinite(pid) && pid > 0),
      () => [] as number[], // lsof exits 1 when nothing is listening
    );
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        // SIGKILL rather than SIGTERM: this runs in teardown, and a hub that
        // takes its time closing streams would leave the next test binding a
        // port that is still held.
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone between the listing and the signal
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
};

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
    // `catch`, not `finally`: `finally` re-throws, so an rm that failed on a
    // busy or unreadable tree would reject a promise nobody is holding, and
    // Playwright would report an unattributed run failure instead of the
    // startup error the caller is waiting for.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  let onEarlyExit: (code: number | null) => void = () => {};

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      void abandon().then(() => reject(new Error("hub did not start within 15s")));
    }, 15_000);
    let buf = "";
    onEarlyExit = (code) => {
      clearTimeout(timer);
      // Already dead, so only the directory is left to take with it.
      void rm(dir, { recursive: true, force: true })
        .catch(() => {})
        .then(() => reject(new Error(`hub exited early (${code}): ${buf}`)));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(Number.parseInt(m[1], 10));
      }
    });
    child.once("exit", onEarlyExit);
  });

  // Removed the moment the hub is up, and this is not tidiness: left attached
  // it survives into the test and into `stop()`, where it fires FIRST on
  // SIGTERM and starts an unawaited `rm` of the same tree. That concurrent rm
  // made `stop()`'s own awaited rm return early - measured at 6ms against 29ms,
  // with 836 of 841 entries still on disk after the process exited. It also
  // meant a hub that CRASHED mid-test had its registry deleted underneath the
  // test still using it. The two rare paths this commit fixed cost the one
  // every hub in the suite takes.
  child.off("exit", onEarlyExit);
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
