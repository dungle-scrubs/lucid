import { on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { fullyVisibleIn, isHittable } from "./visual.ts";
import {
  makeCli,
  openAll,
  openIntoHub,
  PLAN_V1,
  startHub,
  waitTimeoutSeconds,
  writeScaleArtifacts,
  type Cli,
  type Hub,
} from "./helpers.ts";

/**
 * Three scale scenarios are NOT here, and their absence is deliberate:
 * `tabs-many-strip-scrolls`, `tabs-stream-cap-reconnects-on-activate` and
 * `drawer-open-large-project` all need a shell holding twelve tabs, and the
 * product does not reliably get there by either path (finding #53: the drawer
 * opens six of twelve deterministically and says nothing; per-open reaches
 * five in a 60s budget). Writing them against six tabs would assert a number
 * nobody chose; writing them with a retry loop would hide the defect inside
 * the harness. They stay uncovered until the product converges.
 */

/**
 * What happens at a dozen sessions rather than two (M5.3, scale-fixture).
 *
 * Every scenario here fails the same way when it fails: something that worked
 * at two sessions silently stops at twelve - a port pool runs out, a strip
 * grows past the window, a stream cap evicts the tab you are looking at. So
 * each asserts the property that survives scale rather than a count, and the
 * counts are chosen to cross a real threshold in the product: the port pool is
 * eight, the stream cap is ten.
 */

let cli: Cli | undefined;
let hub: Hub | undefined;
let opened: string[] = [];

test.afterEach(async () => {
  // Every artifact opened here binds a port and writes a descriptor; the
  // fixture's own cleanup only ends the one it made.
  for (const artifact of opened) {
    try {
      await cli?.run(["end", artifact]);
    } catch {
      /* already ended */
    }
  }
  opened = [];
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
});

test("opening more sessions than the fixed port pool still works", async () => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  // Twelve, against a pool of eight fixed ports plus an ephemeral fallback -
  // the count is chosen to cross that boundary rather than to be large.
  const { artifacts } = await writeScaleArtifacts(cli, 12);
  opened = [...artifacts];
  await openAll(cli, artifacts);

  const listing = (await cli.run([])) as {
    sessions: { session: string; live?: boolean; viewer?: string }[];
  };
  const live = listing.sessions.filter((s) => s.live === true);

  // All twelve alive: the ninth onward must fall through to an ephemeral port
  // rather than failing to bind. A partial success here is the regression -
  // eight working sessions and four silent failures reads as "it works" to
  // anyone who only opened a few.
  expect(live.length, `only ${live.length} of 12 sessions came up live`).toBe(12);

  // ...on twelve DISTINCT addresses. Two sessions sharing a port would mean
  // one of them is answering for the other.
  const viewers = new Set(live.map((s) => s.viewer));
  expect(viewers.size).toBe(12);
});

test("a hub hosting twenty sessions binds one port and lists them all", async () => {
  test.slow();
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  const { artifacts } = await writeScaleArtifacts(cli, 19);
  await openAll(cli, artifacts);

  // The hub's whole point at scale: ONE listening port for twenty sessions,
  // where the dedicated-server path would have bound twenty. The sessions are
  // hub-hosted, so each descriptor names the hub's port and its own mount.
  const listing = (await cli.run([])) as {
    sessions: { session: string; live?: boolean; viewer?: string }[];
  };
  const live = listing.sessions.filter((s) => s.live === true);
  expect(live.length).toBe(20);
  const ports = new Set(live.map((s) => new URL(String(s.viewer)).port));
  expect(ports.size, `twenty hub-hosted sessions bound ${ports.size} ports`).toBe(1);
  expect([...ports][0]).toBe(String(hub.port));
});

test("a long pick list scrolls inside itself, and its last row is clickable", async ({ page }) => {
  test.slow();
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  const { artifacts } = await writeScaleArtifacts(cli, 40);
  await openAll(cli, artifacts);
  opened = [...artifacts];

  await page.goto(hub.url);
  // The hub scans only its own dir, so point it at the project - through the
  // endpoint the folder chooser posts to, since a test cannot drive a native
  // dialog.
  const rooted = await page.request.post(`http://127.0.0.1:${hub.port}/hub/roots`, {
    data: { path: cli.dir },
  });
  expect(rooted.ok(), await rooted.text()).toBe(true);
  await expect(on(page).pickerRow()).toHaveCount(40, { timeout: 30_000 });

  // The PAGE does not scroll: the list owns its overflow, or the pick screen
  // grows past the window and the rows at the bottom are unreachable.
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(
    pageOverflow,
    "a 40-row listing scrolled the page instead of the list",
  ).toBeLessThanOrEqual(1);

  // The last row is reachable by scrolling the list itself, and hittable when
  // it gets there - the c9d7f86 lesson: present in the DOM is not the claim.
  const rows = on(page).pickerRow();
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  expect(await isHittable(last), "the last row is not clickable once scrolled to").toBe(true);
});

test("project headings stay put while a long list scrolls, and are not clickable", async ({
  page,
}) => {
  test.slow();
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  const { artifacts } = await writeScaleArtifacts(cli, 30);
  await openAll(cli, artifacts);
  opened = [...artifacts];

  await page.goto(hub.url);
  // The endpoint the folder chooser posts to: adding a root from the browser is
  // a native dialog now, which a test cannot drive. This scenario is about 30
  // rows and a sticky heading, not about how the root arrived.
  const added = await page.request.post(`http://127.0.0.1:${hub.port}/hub/roots`, {
    data: { path: cli.dir },
  });
  expect(added.ok(), await added.text()).toBe(true);
  await expect(on(page).pickerRow()).toHaveCount(30, { timeout: 30_000 });

  const heading = on(page).pickerProject().first();
  await expect(heading).toBeVisible();

  // Scroll deep into the group, then check the heading is still on screen:
  // that is what tells a human WHICH project the rows under their cursor
  // belong to, and it is the only thing that does.
  await on(page).pickerRow().last().scrollIntoViewIfNeeded();
  await expect(heading, "the project heading scrolled away from its own rows").toBeVisible();
  const list = on(page).sessionsList().first();
  if ((await list.count()) > 0) {
    expect(await fullyVisibleIn(heading, list)).toBe(true);
  }

  // A heading is a label, not a control: clicking one must open nothing.
  const before = await on(page).shellTab().count();
  await heading.click();
  await expect(on(page).shellTab()).toHaveCount(before);
});

test("a large backlog comes back as one parseable JSON document", async () => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  await cli.run(["open", cli.artifact]);

  // 100 annotations with long notes, appended through the CLI's own path.
  // The claim is about the PAYLOAD, not the UI: an agent parses stdout, so a
  // truncation or an interleaved log line breaks every integration at once.
  const note = "a".repeat(400);
  for (let i = 0; i < 100; i++) {
    await cli.run([
      "ask",
      cli.artifact,
      "--text",
      `question ${String(i).padStart(3, "0")}: ${note}`,
    ]);
  }

  const payload = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(5)])) as {
    questions?: { text: string }[];
  };

  // `cli.run` JSON.parses stdout and throws a CliFailure if it is not one
  // document, so reaching here at all is the no-truncation claim. The count
  // is what proves nothing was dropped on the way.
  expect(payload.questions?.length, "the backlog came back short").toBe(100);
  expect(payload.questions?.[99]?.text).toContain("question 099");
});
