import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type FrameLocator, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

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

  const run = async (args: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> => {
    const { stdout } = await execFileAsync("bun", ["run", MAIN, ...args], {
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
    return JSON.parse(stdout) as Record<string, unknown>;
  };

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
  const run = async (args: string[], timeoutMs = 30_000) => {
    const { stdout } = await execFileAsync("bun", ["run", MAIN, ...args], {
      cwd: c.dir,
      timeout: timeoutMs,
      env: { ...hub.env, LUCID_IDLE_MS: "0" },
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
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
 * services `measure-content` from the same `onMessage` switch that applies a
 * theme, and postMessage delivery to one window is ordered, so a reply to a
 * message posted AFTER the action proves the action's message was handled
 * first. `width` is discarded - the round trip is the whole point.
 */
export const overlaySettled = async (page: Page): Promise<void> => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const frame = Array.from(
          document.querySelectorAll<HTMLIFrameElement>('iframe[title="artifact surface"]'),
        ).find((el) => el.offsetParent !== null || el.getClientRects().length > 0);
        if (!frame?.contentWindow) {
          reject(new Error("no visible artifact surface to settle"));
          return;
        }
        const timer = setTimeout(() => {
          window.removeEventListener("message", onReply);
          reject(new Error("overlay did not answer measure-content"));
        }, 10_000);
        function onReply(e: MessageEvent): void {
          const d = e.data as { source?: string; type?: string } | null;
          if (d?.source !== "lucid-overlay" || d.type !== "content-width") return;
          clearTimeout(timer);
          window.removeEventListener("message", onReply);
          resolve();
        }
        window.addEventListener("message", onReply);
        frame.contentWindow.postMessage({ source: "lucid-chrome", type: "measure-content" }, "*");
      }),
  );
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
