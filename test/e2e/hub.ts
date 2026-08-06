// A real `lucid hub`, isolated from the one you are running.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { FIXED_HUB_BASE_OFFSET } from "./hub-offset.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hubPort, portBase } from "../../src/core/ports.ts";
import { invoke, makeCli, MAIN, type Cli } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";

const execFileAsync = promisify(execFile);

/**
 * How far the harness's FIXED-port hubs sit above the product's own numbers.
 *
 * `hubPort(portBase(env))` alone is 17428 on slot 0 - the exact port the human's
 * `lucid hub` is on while they work, which is measurably true on this machine
 * right now. A suite that binds it either fails to start or, worse, is answered
 * by their hub. So the offset is added to the BASE rather than to the port,
 * preserving the per-slot stride (20).
 *
 * The offset MUST NOT be a multiple of that stride. The first version of this
 * constant was 100 = 5 x 20, which put slot N's fixed hub on exactly slot
 * N+5's DEFAULT hub port (17428 + 20N + 100 = 17428 + 20(N+5)) - so at six or
 * more workers, `killHubOnPort` in one worker would SIGKILL another worker's
 * ordinary hub mid-test, an unattributable cross-worker failure. Found by the
 * M6.2 adversarial review while the config still ran single-worker, which is
 * the only reason it never fired. 110 is not divisible by 20, so no slot's
 * fixed port can coincide with any slot's default port; `test/ports.test.ts`
 * pins the property so the next edit cannot silently restore the collision.
 */

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
      // Only kill what LOOKS like a lucid process. lsof answers with whatever
      // holds the port - and a suite that SIGKILLs the user's unrelated
      // process because a port collided is exactly the asymmetry
      // `survivingProcesses` was written to avoid. An unrecognized holder is
      // reported by the throw below when the port never frees.
      const command = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]).then(
        ({ stdout }) => stdout.trim(),
        () => "", // already gone
      );
      if (command !== "" && !command.includes("lucid") && !command.includes("main.ts")) continue;
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
  // Returning here as if it worked would make a port this function could not
  // free indistinguishable from one it did - the next startHub({port}) then
  // dies with "hub exited early" and the cause is invisible. Same "never
  // silently" rule killSurvivors follows.
  throw new Error(
    `killHubOnPort(${port}): the port is still held after 2s - the listener is either not ours (see the ownership check) or not dying`,
  );
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
  stop(options?: HubStopOptions): Promise<void>;
}

export interface HubStopOptions {
  /**
   * Leave the state dir on disk, so another `startHub({ dir })` can come up on
   * the same registry - the hub RESTART the recovery scenarios need.
   *
   * The default stays "the temp dir dies with the hub that owns it", because
   * for every other suite a leftover dir is a ghost session in somebody else's
   * listing. Keeping it hands ownership to the caller: the test that asked for
   * it is the one that has to remove it.
   */
  readonly keepState?: boolean;
}

export interface HubOptions {
  /** Run the attend engine, so `/hub/create` spawns instead of answering 403. */
  readonly attend?: boolean;
  /** A harness registry for this hub alone, written into the hub's dir and
   *  pointed at by LUCID_HARNESSES - the user's own
   *  `~/.config/lucid/harnesses.json` is never read by these tests. */
  readonly harnesses?: unknown;
  /**
   * Bind THIS port rather than an ephemeral one.
   *
   * Ephemeral is right for every suite that only needs "a hub": a port nobody
   * chose cannot collide. It is also why reattach was unreachable - a restarted
   * hub on a new port is a different hub as far as every open window is
   * concerned. Use `fixedHubPort()`, never a number.
   */
  readonly port?: number;
  /**
   * Reuse a state dir kept by an earlier `stop({ keepState: true })`.
   *
   * The registry is the other half of identity: a hub back on the same port
   * with an empty registry re-adopts nothing, so the two options are only
   * useful together.
   */
  readonly dir?: string;
  /**
   * Cap the shell's reconnect backoff, in ms (the D-015
   * `LUCID_SSE_MAX_BACKOFF_MS` seam), for the tests that kill a stream on
   * purpose. The client clamps to the production 15s ceiling either way, so
   * this can only make the wait shorter.
   */
  readonly sseMaxBackoffMs?: number;
  /**
   * Lower the shell's connected-stream cap (the M3.1 LUCID_STREAM_CAP
   * seam), for the one suite that proves an evicted background tab's badge
   * survives its stream.
   */
  readonly streamCap?: number;
}

export const startHub = async (options: HubOptions = {}): Promise<Hub> => {
  // A caller-supplied dir is a RESTART onto existing state; only a hub that
  // made its own dir may destroy it on a failed startup.
  const ownsDir = options.dir === undefined;
  const dir = options.dir ?? (await realpath(await mkdtemp(join(tmpdir(), "lucid-hub-e2e-"))));
  if (options.harnesses !== undefined) {
    // The path `harnessEnv` already points LUCID_HARNESSES at; writing the file
    // is what turns it from "isolated and absent" into "isolated and stocked".
    await writeFile(join(dir, "harnesses.json"), JSON.stringify(options.harnesses, null, 2));
  }
  const env = {
    ...harnessEnv(dir),
    // No scan of the real ~/dev: the isolated registry is the only source.
    LUCID_HUB_ROOTS: dir,
    // Read by `renderShellPage` and by every session this hub mounts, so one
    // value reaches the shell window and its tabs alike.
    ...(options.sseMaxBackoffMs === undefined
      ? {}
      : { LUCID_SSE_MAX_BACKOFF_MS: String(options.sseMaxBackoffMs) }),
    ...(options.streamCap === undefined ? {} : { LUCID_STREAM_CAP: String(options.streamCap) }),
  };
  const child: ChildProcess = spawn(
    "bun",
    [
      "run",
      MAIN,
      "hub",
      "--port",
      String(options.port ?? 0),
      ...(options.attend ? ["--attend"] : []),
    ],
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
    if (ownsDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  let onEarlyExit: (code: number | null) => void = () => {};

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      void abandon().then(() => reject(new Error("hub did not start within 15s")));
    }, 15_000);
    let buf = "";
    onEarlyExit = (code) => {
      clearTimeout(timer);
      // Already dead, so only the directory is left to take with it - unless
      // the caller owns it, in which case a failed restart must not delete the
      // registry the test is about to assert on.
      void (ownsDir ? rm(dir, { recursive: true, force: true }) : Promise.resolve())
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
    // else's listing. `keepState` is the one exception - a RESTART is the same
    // registry under a new process, so the dir has to outlive the first one.
    stop: async (stopOptions: HubStopOptions = {}) => {
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
      if (stopOptions.keepState !== true) await rm(dir, { recursive: true, force: true });
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
