import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// `invoke` is off the barrel because it takes a raw env, and both halves of
// this suite need one: `LUCID_SURFACE` is the thing under test and
// `LUCID_OPEN_LOG` is what makes a would-be browser launch observable.
import { invoke } from "./cli.ts";
import { makeCli, PLAN_V1, startHub, type Cli, type Hub } from "./helpers.ts";
// The no-hub arms need the same isolated environment `makeCli` runs under -
// which includes a discovery port pinned at a DEAD hub, so `open` falls
// through to a dedicated per-session server.
import { harnessEnv } from "./harness-env.ts";
import { on } from "./locators.ts";

/**
 * The embedded solo surface (plan 06, M1.4).
 *
 * Inside a chat desktop app the browser pane is a window over ONE session -
 * the chat app already plays the role the shell plays for a terminal harness -
 * so `LUCID_SURFACE=embedded` makes `open` return the shell-free review URL
 * and pop no browser. Without it nothing changes at all, which is what the
 * control arms below are for.
 */

let cli: Cli | undefined;
let hub: Hub | undefined;

test.afterEach(async () => {
  await hub?.stop();
  await cli?.cleanup();
  hub = undefined;
  cli = undefined;
});

const launches = async (path: string): Promise<{ how: string; url: string }[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { how: string; url: string });

/** The review UI, as opposed to the artifact-with-overlay mount root or the
 *  shell: the composer is the surface a human types feedback into. */
const showsTheReviewUi = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect(on(page).messageInput()).toBeVisible({ timeout: 15_000 });
};

test("embedded with NO hub returns the solo viewer and launches no browser", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const openLog = join(cli.dir, "open.ndjson");
  // NOT LUCID_NO_OPEN: that suppression path RECORDS a `skipped` entry, so an
  // empty log under it would prove nothing about the surface (D-012). The
  // embedded path must not reach `openBrowser` at all.
  const opened = (await invoke(["open", cli.artifact], {
    cwd: cli.dir,
    timeout: 30_000,
    env: {
      ...harnessEnv(cli.dir),
      // Discovery at a DEAD port, exactly as `makeCli`'s own `run` pins it.
      // `harnessEnv` does not decide this one - the policy calls it per-suite -
      // so a suite that builds its env by hand and forgets reaches whatever hub
      // the developer happens to have running. Measured: without this the arm
      // hit a real hub on 17428 and asserted against somebody's live session.
      LUCID_HUB_PORT: "1",
      LUCID_SURFACE: "embedded",
      LUCID_OPEN_LOG: openLog,
    },
  })) as { url: string; surface?: string };

  expect(opened.surface).toBe("embedded");
  expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__lucid\/viewer$/);
  expect(await launches(openLog), "the embedded path reached openBrowser").toEqual([]);

  await page.goto(opened.url);
  await showsTheReviewUi(page);
  // The review UI, and no shell around it.
  await expect(on(page).shellTabbar()).toHaveCount(0);
});

test("embedded with a hub UP returns the mounted solo viewer, still hub-hosted", async ({
  page,
}) => {
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  const openLog = join(cli.dir, "open.ndjson");
  const opened = (await invoke(["open", cli.artifact], {
    cwd: cli.dir,
    timeout: 30_000,
    env: { ...hub.env, LUCID_SURFACE: "embedded", LUCID_OPEN_LOG: openLog },
  })) as { url: string; surface?: string };

  expect(opened.surface).toBe("embedded");
  // The hub's port with the session's mount prefix - not a second process on a
  // second port. Surface decides presentation only, never topology (D-006).
  expect(opened.url).toBe(
    `http://127.0.0.1:${hub.port}/s/${/\/s\/([a-f0-9]+)\//.exec(opened.url)?.[1]}/__lucid/viewer`,
  );
  expect(opened.url).toContain(`127.0.0.1:${hub.port}/s/`);
  expect(await launches(openLog), "the embedded path reached openBrowser").toEqual([]);

  await page.goto(opened.url);
  await showsTheReviewUi(page);
  await expect(on(page).shellTabbar()).toHaveCount(0);
});

/**
 * The guard on the whole plan: without the variable, both cases return exactly
 * what they returned before it existed.
 *
 * `surfacedInShell` is pinned by opening NO shell window - `run.ts` already
 * skips the launch when the hub reports a live one, so an arm that happens to
 * have a window open is launch-free for a reason that has nothing to do with
 * the surface, and stops controlling anything.
 */
test("without the variable, the shell url and the browser launch are unchanged", async ({
  page,
}) => {
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  const openLog = join(cli.dir, "open.ndjson");
  const opened = (await invoke(["open", cli.artifact], {
    cwd: cli.dir,
    timeout: 30_000,
    env: { ...hub.env, LUCID_OPEN_LOG: openLog },
  })) as { url: string; surface?: string };

  expect(opened.surface).toBe("default");
  expect(opened.url).toContain(`127.0.0.1:${hub.port}/?s=`);
  // No shell window is connected, so the launch genuinely happens - which is
  // what makes the empty logs above attributable to the surface.
  expect((await launches(openLog)).length).toBe(1);

  await page.goto(opened.url);
  await expect(on(page).shellTab()).toHaveCount(1);
});

test("an unknown surface value falls back to default rather than failing the open", async () => {
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  // An integration file from a newer Lucid naming a surface this build does
  // not have must not break the CLI.
  const opened = (await invoke(["open", cli.artifact], {
    cwd: cli.dir,
    timeout: 30_000,
    env: { ...hub.env, LUCID_SURFACE: "hologram" },
  })) as { url: string; surface?: string };

  expect(opened.surface).toBe("default");
  expect(opened.url).toContain(`127.0.0.1:${hub.port}/?s=`);
});
