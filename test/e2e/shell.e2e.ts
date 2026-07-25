import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, type Cli } from "./helpers.ts";

/**
 * The shell (Model B): one daemon window over every session. These tests run
 * a real `lucid hub` on an ephemeral port with an isolated registry, `lucid
 * open` sessions into it, and drive the tab bar.
 */

const REPO = join(import.meta.dirname, "..", "..");
const MAIN = join(REPO, "src", "cli", "main.ts");

interface Hub {
  readonly port: number;
  readonly url: string;
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

let hub: Hub | undefined;
let cli: Cli | undefined;
let cli2: Cli | undefined;
let hubDir: string | undefined;

const startHub = async (): Promise<Hub> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-hub-e2e-"));
  hubDir = dir;
  const registry = join(dir, "registry.json");
  const env = {
    ...process.env,
    LUCID_REGISTRY: registry,
    // No scan of the real ~/dev: the isolated registry is the only source.
    LUCID_HUB_ROOTS: dir,
    LUCID_NO_OPEN: "1",
  } as Record<string, string>;
  const child: ChildProcess = spawn("bun", ["run", MAIN, "hub", "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    env: { ...env, LUCID_HUB_PORT: String(port) },
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
    },
  };
};

/** `lucid open` against the hub: a CLI whose env routes discovery at it. */
const openIntoHub = async (theHub: Hub, html: string): Promise<{ cli: Cli; shellUrl: string }> => {
  const c = await makeCli(html);
  // Rebind the CLI's env to the hub (makeCli's own env has no LUCID_HUB_PORT).
  const run = async (args: string[], timeoutMs = 30_000) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("bun", ["run", MAIN, ...args], {
      cwd: c.dir,
      timeout: timeoutMs,
      env: { ...theHub.env, LUCID_IDLE_MS: "0" },
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  const opened = (await run(["open", c.artifact])) as { url: string };
  expect(opened.url).toContain(`127.0.0.1:${theHub.port}/?s=`);
  return { cli: { ...c, run } as Cli, shellUrl: opened.url };
};

// :visible - every open tab's view stays mounted, so N iframes exist and
// only the active one is showing.
const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]:visible');

test.afterEach(async () => {
  await cli?.cleanup();
  await cli2?.cleanup();
  cli = cli2 = undefined;
  await hub?.stop();
  hub = undefined;
  if (hubDir) await rm(hubDir, { recursive: true, force: true });
  hubDir = undefined;
});

test("lucid open surfaces the session as a tab in the shell", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  // The ?s= tab opens itself once the listing names it.
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(page.locator('[data-test="shell-tab"]')).toContainText("plan.html");
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
});

test("the review loop works through the daemon mount", async ({ page }) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  const surface = surfaceOf(page);
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator('textarea[placeholder^="What should change here?"]')
    .fill("One batch, please.");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  // The agent's wait sees the annotation appended by the daemon-hosted mount.
  const feedback = (await cli.run(["wait", cli.artifact, "--timeout", "8"])) as {
    status: string;
    annotations: { note: string }[];
  };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations.some((a) => a.note.includes("One batch"))).toBe(true);
});

test("tabs scope to a project; the drawer switches; drafts survive", async ({ page }) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const second = await openIntoHub(
    hub,
    PLAN_V1.replace("Database migration plan", "Rollout checklist"),
  );
  cli2 = second.cli;

  await page.goto(first.shellUrl);
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  // The strip is project-scoped: the scope label names the boot session's project.
  await expect(page.locator('[data-test="scope-label"]')).toBeVisible();

  // "+" shows the pick screen SCOPED to this project; the second session
  // lives in another project, so widen to all projects first. The row must
  // be truly HITTABLE (elementFromPoint sees what a human sees - a clipped
  // popover once passed playwright's auto-scroll and failed a real pointer).
  await page.locator('[data-test="tab-add"]').click();
  await page.locator('[data-test="scope-clear"]').click();
  const row = page.locator('[data-test="picker-row"]').first();
  await expect(row).toBeVisible();
  const hittable = await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (el === hit || el.contains(hit));
  });
  expect(hittable).toBe(true);
  await page
    .locator('[data-test="picker-project"]', { hasText: second.cli.dir })
    .locator('[data-test="picker-row"]')
    .first()
    .click();

  // Opening it rescopes the strip to ITS project: one visible tab, the other
  // project's tab hidden, not gone.
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(surfaceOf(page).locator("h1")).toContainText("Rollout checklist");

  // Draft an annotation note AND a message here, then switch projects via
  // the drawer. Views stay mounted (display:none), so assertions use :visible.
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator('textarea[placeholder^="What should change here?"]:visible')
    .fill("only for the checklist");
  await page
    .locator('[data-test="message-input"]:visible')
    .fill("an unsent message must survive a project switch");

  await page.locator('[data-test="drawer-toggle"]').click();
  await expect(page.locator('[data-test="projects-drawer"]')).toBeVisible();
  await page.locator('[data-test="drawer-project"]', { hasText: cli.dir }).click();
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  await expect(
    page.locator('textarea[placeholder^="What should change here?"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator('[data-test="message-input"]:visible')).toHaveValue("");

  // Back via the drawer: BOTH drafts survived - the annotation note in the
  // session store, the message draft in assistant-ui component state, which
  // is exactly why hidden views stay mounted.
  await page.locator('[data-test="drawer-toggle"]').click();
  await page.locator('[data-test="drawer-project"]', { hasText: second.cli.dir }).click();
  await expect(
    page.locator('textarea[placeholder^="What should change here?"]:visible'),
  ).toHaveValue("only for the checklist");
  await expect(page.locator('[data-test="message-input"]:visible')).toHaveValue(
    "an unsent message must survive a project switch",
  );
});

test("the command palette opens sessions and runs review actions", async ({ page }) => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const second = await openIntoHub(
    hub,
    PLAN_V1.replace("Database migration plan", "Rollout checklist"),
  );
  cli2 = second.cli;

  await page.goto(first.shellUrl);
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);

  const cmdK = process.platform === "darwin" ? "Meta+k" : "Control+k";

  // ⌘K -> fuzzy to the second session -> Enter opens it as a tab.
  await page.keyboard.press(cmdK);
  await expect(page.locator('[data-test="palette-input"]')).toBeFocused();
  await page.locator('[data-test="palette-input"]').fill("open plan");
  await page.locator('[data-test="palette"] [cmdk-item]', { hasText: "plan.html" }).first().click();
  await expect(page.locator('[data-test="palette-overlay"]')).toHaveCount(0);
  // Cross-project open rescopes the strip: one visible tab in the new project.
  await expect(page.locator('[data-test="shell-tab"]')).toHaveCount(1);
  await expect(surfaceOf(page).locator("h1")).toContainText("Rollout checklist");

  // ⌘K -> "toggle marks" runs an action on the ACTIVE session.
  await page.keyboard.press(cmdK);
  await page.locator('[data-test="palette-input"]').fill("toggle");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-test="palette-overlay"]')).toHaveCount(0);

  // Escape closes a reopened palette without running anything.
  await page.keyboard.press(cmdK);
  await expect(page.locator('[data-test="palette-input"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-test="palette-overlay"]')).toHaveCount(0);
});
