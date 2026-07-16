import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO = join(import.meta.dirname, "..", "..");
const MAIN = join(REPO, "src", "cli", "main.ts");

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
      env: { ...process.env, LUCID_NO_OPEN: "1", LUCID_IDLE_MS: "0" },
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
