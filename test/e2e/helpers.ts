import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type FrameLocator, type Page, type Route } from "@playwright/test";
import { type CliOutcome, interpretCliResult } from "./cli-result.ts";
export { killSessionServer } from "./kill-server.ts";

const execFileAsync = promisify(execFile);

/**
 * Run the CLI and interpret what came back.
 *
 * `execFile` rejects with `Command failed` and hangs the exit code, stdout and
 * stderr off the error object where nobody looks, so the rejection is caught
 * here and turned into the full outcome before `interpretCliResult` judges it.
 * A genuine spawn failure - no such binary - is re-thrown untouched, because
 * that is not the CLI answering at all.
 */
const invoke = async (
  args: readonly string[],
  options: Parameters<typeof execFileAsync>[2] & { timeout?: number },
): Promise<Record<string, unknown>> => {
  let outcome: CliOutcome;
  try {
    const { stdout, stderr } = await execFileAsync("bun", ["run", MAIN, ...args], options);
    outcome = { argv: args, code: 0, signal: null, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      signal?: NodeJS.Signals;
      killed?: boolean;
    };
    // `code` is a number for an exit, a string like ENOENT for a spawn failure.
    const code = typeof failed.code === "number" ? failed.code : null;
    const signal = failed.signal ?? null;
    if (code === null && signal === null) throw error;
    outcome = {
      argv: args,
      code,
      signal,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      killed: failed.killed === true,
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    };
  }
  return interpretCliResult(outcome);
};

const REPO = join(import.meta.dirname, "..", "..");
/** The CLI entrypoint, exported so a suite can spawn a long-running invocation
 *  (a blocked `wait`) with an env of its own. */
export const MAIN = join(REPO, "src", "cli", "main.ts");

export interface Cli {
  readonly dir: string;
  readonly artifact: string;
  run(args: string[], timeoutMs?: number): Promise<Record<string, unknown>>;
  write(html: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** Spawn a `lucid` CLI invocation (dev mode via bun) and parse its JSON output. */
export const makeCli = async (initialHtml: string): Promise<Cli> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-e2e-"));
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, initialHtml);

  const run = async (args: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> =>
    invoke(args, {
      cwd: dir,
      timeout: timeoutMs,
      env: {
        ...process.env,
        LUCID_NO_OPEN: "1",
        LUCID_IDLE_MS: "0",
        // Isolated: `open` registers every session in the hub registry, and
        // without this each e2e run leaves dead /tmp pointers in the REAL
        // ~/.lucid/registry.json - which the user's shell then lists as
        // ghost sessions.
        // Fixtures live in a temp dir by design; `open` refuses those for
        // real work (they do not survive a reboot).
        LUCID_ALLOW_TEMP: "1",
        LUCID_REGISTRY: join(dir, "registry.json"),
        // Same containment for the added-roots file, so nothing a CLI does
        // here can point the user's own shell at a temp tree.
        LUCID_ROOTS: join(dir, "roots.json"),
        // A hub the USER happens to be running would hijack `open` into
        // daemon mode (a tab in their shell) and change what these tests
        // see. Point discovery at a dead port so the dedicated-server path
        // is taken deterministically; shell.e2e.ts overrides this with its
        // own isolated hub.
        LUCID_HUB_PORT: "1",
      },
    });

  return {
    dir,
    artifact,
    run,
    write: (html: string) => writeFile(artifact, html),
    cleanup: async () => {
      try {
        await execFileAsync("bun", ["run", MAIN, "end", artifact], {
          cwd: dir,
          env: { ...process.env, LUCID_NO_OPEN: "1" },
        });
      } catch {
        /* already ended */
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
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
  const registry = join(dir, "registry.json");
  const harnessesPath = join(dir, "harnesses.json");
  if (options.harnesses !== undefined) {
    await writeFile(harnessesPath, JSON.stringify(options.harnesses, null, 2));
  }
  const env = {
    ...process.env,
    LUCID_ALLOW_TEMP: "1",
    LUCID_REGISTRY: registry,
    // No scan of the real ~/dev: the isolated registry is the only source.
    LUCID_HUB_ROOTS: dir,
    // Nor the folders the human added to their own shell - `~/.lucid/roots.json`
    // is scanned ON TOP of LUCID_HUB_ROOTS, so it needs isolating too.
    LUCID_ROOTS: join(dir, "roots.json"),
    LUCID_NO_OPEN: "1",
    ...(options.harnesses !== undefined ? { LUCID_HARNESSES: harnessesPath } : {}),
  } as Record<string, string>;
  const child: ChildProcess = spawn(
    "bun",
    ["run", MAIN, "hub", "--port", "0", ...(options.attend ? ["--attend"] : [])],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hub did not start")), 15_000);
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
      reject(new Error(`hub exited early (${code}): ${buf}`));
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

/** The active session's artifact frame. `:visible` because every open tab's
 *  view stays mounted, so N iframes exist and only one is showing. */
export const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]:visible');

/**
 * Resolve once the visible overlay has drained everything the chrome sent it
 * before this call.
 *
 * The reason this exists: some chrome actions are asserted by their ABSENCE of
 * effect on the artifact - a theme the artifact declines, a highlight for an
 * anchor it cannot find. There is no state transition to await, so a polling
 * assertion resolves against the value that was already there and passes before
 * the overlay has even read the message. That is not a slow-machine problem; a
 * fast machine is precisely where it passes wrongly, which is how a laptop can
 * stay green on a claim CI disproves.
 *
 * So this posts a message of its own and waits for the answer. The overlay
 * services `ping` from the same synchronous `onMessage` switch that applies a
 * theme, and postMessage delivery to one window is ordered, so a `pong` proves
 * the action's message was handled first.
 *
 * `ping`/`pong` exists for exactly this and does nothing else. Borrowing a real
 * message would import its effect: `measure-content` looks inert and is not -
 * the chrome answers it by resizing the review panel AND writing the new width
 * to localStorage, so a probe named "settled" would quietly resize the surface
 * and change state that outlives the test. The nonce keeps a reply attributable
 * to the probe that asked for it, so a reply still in flight from an earlier
 * call cannot resolve this one early.
 */
export const overlaySettled = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const nonce = `settle-${Math.random().toString(36).slice(2)}`;
    const frame = Array.from(
      document.querySelectorAll<HTMLIFrameElement>('iframe[title="artifact surface"]'),
    ).find((el) => el.offsetParent !== null || el.getClientRects().length > 0);
    if (!frame?.contentWindow) throw new Error("no visible artifact surface to settle");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onReply);
        reject(new Error(`overlay did not answer ping ${nonce}`));
      }, 10_000);
      function onReply(e: MessageEvent): void {
        const d = e.data as { source?: string; type?: string; nonce?: string } | null;
        if (d?.source !== "lucid-overlay" || d.type !== "pong" || d.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener("message", onReply);
        resolve();
      }
      window.addEventListener("message", onReply);
      frame.contentWindow?.postMessage({ source: "lucid-chrome", type: "ping", nonce }, "*");
    });
  });
};

export const PLAN_V1 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Migration plan</title>
<style>body{font-family:system-ui;max-width:760px;margin:40px auto;color:#1a202c}li{margin:6px 0}</style>
</head>
<body>
  <article>
    <h1>Database migration plan</h1>
    <ol id="steps">
      <li data-lucid-id="step-backfill">Backfill from the events table nightly</li>
      <li>Cut over reads to the new store</li>
      <li>Decommission the legacy table</li>
    </ol>
    <p id="note">This plan assumes zero downtime is required for the cutover.</p>
  </article>
</body>
</html>`;

export const PLAN_V2 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Migration plan</title>
<style>body{font-family:system-ui;max-width:760px;margin:40px auto;color:#1a202c}li{margin:6px 0}</style>
</head>
<body>
  <article>
    <h1>Database migration plan (revised)</h1>
    <ol id="steps">
      <li data-lucid-id="step-backfill">Backfill from the events table in one batch</li>
      <li>Verify row counts match</li>
      <li>Cut over reads to the new store</li>
      <li>Decommission the legacy table</li>
    </ol>
    <p id="note">This plan assumes zero downtime is required for the cutover.</p>
  </article>
</body>
</html>`;

/**
 * Interfering with a request the page is about to make.
 *
 * Three shapes, because they fail differently and the difference is the point:
 * a slow response is still a response, an aborted one never arrives, and a
 * stubbed error arrives quickly and says something specific. A suite asserting
 * "the composer keeps the message when the server is gone" needs the second;
 * one asserting "a 500 surfaces the server's reason" needs the third.
 *
 * Each takes the URL pattern rather than wrapping a fixed route, so the caller
 * names the endpoint it is talking about at the call site.
 */
export const delayRoute = async (
  page: Page,
  pattern: string | RegExp,
  ms: number,
): Promise<void> => {
  await page.route(pattern, async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    // The whole job of this helper is to still be holding a request when
    // something else happens, so the page navigating or closing mid-delay is
    // the LIKELY path, not the exotic one - and `continue()` rejects inside a
    // route handler when it does. Swallowed: the test has already moved on, and
    // an unhandled rejection here would fail whatever ran next instead.
    await route.continue().catch(() => {});
  });
};

/** Make the request fail as though the connection dropped. */
export const abortRoute = async (page: Page, pattern: string | RegExp): Promise<void> => {
  await page.route(pattern, (route: Route) => route.abort("connectionfailed"));
};

/** Answer the request without it reaching the server. */
export const stubRoute = async (
  page: Page,
  pattern: string | RegExp,
  response: { status?: number; body?: string; contentType?: string },
): Promise<void> => {
  await page.route(pattern, (route: Route) =>
    route.fulfill({
      status: response.status ?? 200,
      contentType: response.contentType ?? "application/json",
      body: response.body ?? "{}",
    }),
  );
};
