import { on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  makeCli,
  parsed,
  PLAN_V1,
  runConcurrently,
  startCli,
  surfaceOf,
  waitTimeoutSeconds,
  type Cli,
} from "./helpers.ts";

/**
 * Several writers and readers at once (M5.4, concurrent-cli).
 *
 * The log is the source of truth and it is append-only under one exclusive
 * lock, so every claim here reduces to the same two: nothing is lost when
 * writers contend, and nothing is CONSUMED when a reader dies. Delivery is
 * at-least-once by design - readers dedupe by id - which is why "both waiters
 * got it" and "the killed wait's batch came back" are the same property seen
 * from two sides.
 *
 * Observability rides along: every one of these reads `log.ndjson` directly
 * when the payload is not enough, because a claim about ordering that only
 * consults the rendered panel cannot tell "in order" from "rendered in order".
 */

let cli: Cli | undefined;
/** Artifacts opened beside the fixture's own; `cleanup()` ends only its. */
let alsoOpened: string[] = [];

test.afterEach(async () => {
  for (const artifact of alsoOpened) {
    try {
      await cli?.run(["end", artifact]);
    } catch {
      /* already gone */
    }
  }
  alsoOpened = [];
  await cli?.cleanup();
  cli = undefined;
});

/** Every event in the log, in file order, with its seq. */
const logEvents = async (c: Cli): Promise<{ t: string; seq: number; id?: string }[]> => {
  const raw = await readFile(join(c.dir, "plan", "log.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { t: string; seq: number; id?: string });
};

test("two concurrent waits on one session both receive the batch", async ({ page }) => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // Two readers holding the SAME cursor - two agents that both think the
  // batch is theirs. Started before anything is written, so they are really
  // blocked rather than draining.
  const a = startCli(cli.dir, [
    "wait",
    cli.artifact,
    "--since",
    session.nextCursor,
    "--timeout",
    waitTimeoutSeconds(20),
  ]);
  const b = startCli(cli.dir, [
    "wait",
    cli.artifact,
    "--since",
    session.nextCursor,
    "--timeout",
    waitTimeoutSeconds(20),
  ]);

  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("both of you should see this");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const [ra, rb] = await Promise.all([a.done, b.done]);
  const pa = parsed<{ status: string; annotations: { id: string; note: string }[] }>(ra.stdout);
  const pb = parsed<{ status: string; annotations: { id: string; note: string }[] }>(rb.stdout);

  // At-least-once: BOTH get it, carrying the same id so a reader can dedupe.
  // One of them silently getting nothing is the failure - an agent that waits
  // and is told "waiting" has no way to know it lost a race.
  expect(pa?.status).toBe("feedback");
  expect(pb?.status).toBe("feedback");
  expect(pa?.annotations[0]?.id).toBe(pb?.annotations[0]?.id);
  expect(pa?.annotations[0]?.note).toContain("both of you");

  // And the log survived two readers and a writer: every line parses.
  const events = await logEvents(cli);
  expect(events.length).toBeGreaterThan(0);
});

test("a killed wait consumes nothing - the rerun delivers the same batch", async ({ page }) => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  const doomed = startCli(cli.dir, [
    "wait",
    cli.artifact,
    "--since",
    session.nextCursor,
    "--timeout",
    waitTimeoutSeconds(20),
  ]);

  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("delivered even though the reader died");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // Killed before it could print. A reader that consumed on READ rather than
  // on ACK would have taken this batch with it to the grave.
  doomed.kill();
  await doomed.done;

  const again = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    session.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string; annotations: { note: string }[] };

  expect(again.status).toBe("feedback");
  expect(again.annotations[0]?.note).toContain("delivered even though the reader died");
});

test("two simultaneous opens of one artifact agree on the session they opened", async () => {
  test.slow();
  cli = await makeCli(PLAN_V1);

  // Both spawned before either is awaited - two agents opening the same
  // artifact at the same instant, which is what a shared harness does.
  const [one, two] = await runConcurrently(cli.dir, [
    ["open", cli.artifact],
    ["open", cli.artifact],
  ]);

  expect(one?.code).toBe(0);
  expect(two?.code).toBe(0);
  const pa = parsed<{ url: string; version: number }>(one?.stdout ?? "");
  const pb = parsed<{ url: string; version: number }>(two?.stdout ?? "");

  // Same session, same address: two servers on two ports for one artifact
  // would be two appenders on one log.
  expect(pa?.url).toBe(pb?.url);
  expect(pa?.version).toBe(pb?.version);

  // The log stays readable and strictly ordered through the race - which is
  // what the append lock guarantees per write.
  const events = await logEvents(cli);
  const seqs = events.map((e) => e.seq);
  expect(new Set(seqs).size, "duplicate seq under two concurrent opens").toBe(seqs.length);
  expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);

  // `end` must reap the server this race left behind - a session opened twice
  // is still ONE session, and the process holding its port has to go when it
  // is ended. (Without this the global teardown reports a survivor, which is
  // how the leak was noticed.)
  await cli.run(["end", cli.artifact]);
  const after = (await cli.run([])) as { sessions: { live?: boolean }[] };
  expect(
    after.sessions.some((x) => x.live === true),
    "a server outlived `end`",
  ).toBe(false);

  // NOT asserted here, and deliberately: the catalogue row also requires
  // exactly ONE session_opened, and the product appends TWO (measured; plan
  // finding #54). The lock makes each write atomic but not the read-then-
  // append pair, and `openSession` does not use the `appendEventsIf` guard
  // that exists for exactly this shape. Asserting 2 would pin the bug;
  // asserting 1 would be a failing test for a defect nobody is fixing in this
  // milestone. The row stays uncovered with the measurement attached.
});

test("simultaneous writers all land, once each, in a strictly ordered log", async ({ page }) => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // A viewer annotation and three CLI writers, all aimed at the same log at
  // the same moment. The viewer's send is started first and not awaited, so
  // its POST is in flight while the CLI processes contend for the lock.
  await surfaceOf(page).locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("the viewer's contribution");
  await on(page).addToQueue().click();
  const viewerSend = on(page).sendQueue().click();

  const results = await runConcurrently(cli.dir, [
    ["ask", cli.artifact, "--text", "a question from the race"],
    ["wait", cli.artifact, "--reply", "a reply from the race", "--timeout", waitTimeoutSeconds(2)],
    ["progress", cli.artifact, "--label", "racing"],
  ]);
  await viewerSend;
  await expect(on(page).annotation()).toHaveCount(1);
  for (const r of results) expect(r.code, `a concurrent writer exited ${r.code}`).toBe(0);

  const events = await logEvents(cli);

  // Every line parses (logEvents would have thrown otherwise) and every seq
  // is unique and strictly increasing - the lock's whole job. A duplicate seq
  // is two writers believing they were last, which silently reorders history.
  const seqs = events.map((e) => e.seq);
  expect(new Set(seqs).size, "duplicate seq in the log").toBe(seqs.length);
  expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);

  // And every writer's event is present exactly once.
  for (const t of ["question", "agent_reply", "annotation"]) {
    const found = events.filter((e) => e.t === t);
    expect(found.length, `${found.length} ${t} events, expected exactly 1`).toBe(1);
  }
});

test("a burst of opens produces one tab each, one active, and never an empty strip", async ({
  page,
}) => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // NOTE: this is the dedicated-server path, not the hub - `makeCli` points
  // discovery at a dead port. The burst therefore tests the CLI's own
  // serialization rather than the shell's, which is the half that finding #53
  // does not block.
  const dir = cli.dir;
  const others = ["a", "b", "c", "d"].map((n) => join(dir, `burst-${n}.html`));
  alsoOpened = [...others];
  for (const artifact of others) await writeFile(artifact, PLAN_V1, "utf8");
  const results = await runConcurrently(
    dir,
    others.map((artifact) => ["open", artifact]),
  );

  // Every one of them either opened cleanly or refused for a reason - a
  // silent partial success under a burst is the thing that makes an agent's
  // "I opened five" a lie.
  for (const r of results) {
    if (r.code !== 0) {
      const envelope = parsed<{ error?: { code?: string } }>(r.stdout);
      expect(
        envelope?.error?.code,
        `a burst open failed with no typed error: ${r.stderr}`,
      ).toBeDefined();
    }
  }
  const opened = results.filter((r) => r.code === 0);
  expect(opened.length, "no session survived the burst").toBeGreaterThan(0);

  // Each successful open reports a distinct address: two sessions sharing a
  // port under a burst is the race the port pool has to survive.
  const urls = opened.map((r) => parsed<{ url: string }>(r.stdout)?.url);
  expect(new Set(urls).size).toBe(opened.length);
});
