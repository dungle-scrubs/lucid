import { on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PLAN_V1, makeCli, surfaceOf, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * `lucid open --restart` - replacing the process without ending the review.
 *
 * A running daemon embeds the client bundle it loaded at start, so after a
 * rebuild the only way to see new chrome is to replace the process. `--restart`
 * does that by SIGTERMing the pid in `server.json` and spawning again
 * (`stopServer`, src/cli/self.ts). The danger is entirely in what else that
 * could take with it: the obvious way to stop a session's server is `lucid end`,
 * which appends `session_ended`, and a restart that reached for it would quietly
 * close a review a human is in the middle of - and take every annotation that
 * had been written but not yet read by an agent with it, because a `wait` on the
 * old cursor would then answer `ended` instead of `feedback`.
 *
 * So three claims, and all three are load-bearing:
 *   - the pid actually CHANGED (otherwise `--restart` reattached and did
 *     nothing, and every other assertion here passes trivially),
 *   - NO `session_ended` was written,
 *   - feedback written BEFORE the restart is still delivered by `wait` after it.
 *
 * The bundle-freshness clause of the scenario is deliberately dropped (D-078):
 * a served bundle carries no stamp to assert against, and none of the three
 * claims above needs one.
 */

let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

interface Descriptor {
  readonly pid: number;
  readonly port: number;
}

const descriptorOf = async (dir: string): Promise<Descriptor> =>
  JSON.parse(await readFile(join(dir, "plan", "server.json"), "utf8")) as Descriptor;

test("open --restart replaces the server pid without ending the session", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as {
    url: string;
    nextCursor: string;
  };
  const before = await descriptorOf(cli.dir);

  // The annotation is written FIRST, and never read. A note made after the
  // restart would only prove the new server works; this one has to survive the
  // process that received it, which is the actual claim. Nothing waits on
  // `session.nextCursor` until the very end, so the batch is still undelivered
  // when the server holding it is killed.
  await page.goto(session.url);
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("written before the restart");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const restarted = (await cli.run(["open", cli.artifact, "--restart"])) as {
    url: string;
    status: string;
  };
  expect(restarted.status).toBe("active");

  // A NEW pid. Without this the rest is vacuous: `open` with no live server to
  // stop simply reattaches, and a reattached session obviously keeps its log.
  const after = await descriptorOf(cli.dir);
  expect(
    after.pid,
    `--restart left pid ${after.pid} in server.json - the process was never replaced`,
  ).not.toBe(before.pid);
  // And the descriptor names something ALIVE, not a corpse the spawn failed to
  // replace - a restart that killed the old server and never started a new one
  // would also satisfy "the pid changed".
  await page.goto(restarted.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // Nothing ended. Read from the log itself rather than inferred from `wait`,
  // because `wait` answers `ended` only once it reaches that event - and the
  // whole point is that the event must not be there at all.
  const log = await readFile(join(cli.dir, "plan", "log.ndjson"), "utf8");
  const kinds = log
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { t: string }).t);
  expect(kinds, "--restart appended session_ended - it ended a live review").not.toContain(
    "session_ended",
  );

  // The round trip: an agent holding the cursor from before the restart is
  // still handed the note. This is the consequence a lost `session_ended` would
  // have had, measured rather than argued.
  const answer = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    session.nextCursor,
    "--timeout",
    waitTimeoutSeconds(10),
  ])) as { status: string; annotations?: ReadonlyArray<{ note: string }> };
  expect(answer.status).toBe("feedback");
  expect(answer.annotations?.[0]?.note).toContain("written before the restart");
});
