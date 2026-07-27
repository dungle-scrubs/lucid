import { on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { realpathSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { parseCursor } from "../../src/core/cursor.ts";
import { CliFailure } from "./cli-result.ts";
import { makeCli, surfaceOf, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * The contract `lucid open` / `lucid wait` print, and the identity rules behind
 * it: what an agent parses, which file a path names, and what a re-open does to
 * the numbers an agent persists.
 *
 * Every payload assertion here is on the EXACT key set rather than on a few
 * fields, because the failure this suite exists to catch is a field quietly
 * appearing, disappearing or being renamed under an integration that parses it.
 */

/**
 * A fixture with NO warnings, which the shared `PLAN_V1` cannot be.
 *
 * `lucid open` appends a `THEME_NOT_ADAPTIVE` warning for any artifact whose
 * colors do not route through the six tokens the viewer remaps - and `PLAN_V1`
 * hardcodes `#1a202c`, so every open of it carries a `warnings` key. Asserting
 * that `warnings` is ABSENT needs an artifact that earns no warning at all:
 * tokens declared, remapped in a dark block, and no color literal anywhere
 * outside a custom-property declaration.
 */
const PLAN_THEMED = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Migration plan</title>
<style>
:root { --paper: #ffffff; --ink: #1a202c; --ink-muted: #4a5568; --rule: #e2e8f0; --accent: #2b6cb0; --accent-wash: #ebf4ff; }
@media (prefers-color-scheme: dark) {
  :root { --paper: #12161c; --ink: #e6edf3; --ink-muted: #9aa7b4; --rule: #232a33; --accent: #79b8ff; --accent-wash: #16202b; }
}
body { background: var(--paper); color: var(--ink); font-family: system-ui; max-width: 760px; margin: 40px auto; }
li { margin: 6px 0; }
</style>
</head>
<body>
  <article>
    <h1>Database migration plan</h1>
    <ol id="steps">
      <li data-lucid-id="step-backfill">Backfill from the events table nightly</li>
      <li>Cut over reads to the new store</li>
    </ol>
  </article>
</body>
</html>`;

/** The numeric part of `evt_00042`, read by the product's own cursor parser.
 *  Cursors are compared as numbers, never as strings: `evt_00009` <
 *  `evt_00010` lexically only by luck of the padding - which the shape
 *  assertion pins, since `parseCursor` deliberately does not. */
const seqOf = (cursor: unknown): number => {
  expect(cursor).toMatch(/^evt_\d{5}$/);
  const seq = parseCursor(String(cursor));
  expect(seq).toBeDefined();
  return seq as number;
};

let cli: Cli | undefined;
/** A second, unrelated CLI (the stranger-cwd scenario); cleaned up like the
 *  first. */
let stranger: Cli | undefined;
/**
 * Sessions whose canonical path is not the string `makeCli` holds.
 *
 * `end` only STOPS a live server when the path it is handed handshakes as the
 * same session, and macOS symlinks the temp root - so `/tmp/x/plan.html` and
 * `/private/tmp/x/plan.html` are one file to the log and two identities to the
 * handshake - the session-identity realpath gap, recorded in the plan
 * ledger. A session opened through a relative path is therefore ended by the
 * absolute path the product itself reported, or its `__serve` process
 * outlives the suite.
 */
let pendingEnds: string[] = [];

test.afterEach(async () => {
  for (const artifact of pendingEnds) {
    if (!cli) break;
    try {
      await cli.run(["end", artifact]);
    } catch {
      /* already ended */
    }
  }
  pendingEnds = [];
  await cli?.cleanup();
  cli = undefined;
  await stranger?.cleanup();
  stranger = undefined;
});

test("a fresh open prints exactly the fields an agent parses, and no warnings", async () => {
  cli = await makeCli(PLAN_THEMED);

  const payload = await cli.run(["open", cli.artifact]);

  // The whole key set, sorted. A weaker "has these fields" assertion passes
  // while an extra field appears or `warnings` shows up on a clean artifact,
  // and both are contract changes an agent parses through.
  expect(Object.keys(payload).sort()).toEqual([
    "nextCursor",
    "session",
    "status",
    "url",
    "version",
  ]);

  // The session id is the ABSOLUTE artifact path - it is what every later
  // command is addressed by, so a relative one would be unusable from
  // anywhere but the cwd that opened it.
  expect(isAbsolute(String(payload.session))).toBe(true);
  expect(payload.session).toBe(cli.artifact);

  expect(payload.version).toBe(1);
  expect(payload.status).toBe("active");
  // First event in a fresh log is seq 1, so the cursor an agent persists is
  // evt_00001 - not evt_00000, and not the seq AFTER it.
  expect(payload.nextCursor).toBe("evt_00001");
  expect(String(payload.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__lucid\/viewer$/);
});

test("a relative path resolves against cwd; a stranger cwd is NOT_FOUND, not an attach", async () => {
  cli = await makeCli(PLAN_THEMED);
  const sub = join(cli.dir, "sub");
  await mkdir(sub);

  // Opened from the artifact's own directory, by a `./` path.
  const opened = await cli.runFrom(cli.dir, ["open", "./plan.html"]);
  pendingEnds.push(String(opened.session));
  // Waited from a CHILD directory, by a `../` path. If these two resolved to
  // different files the wait would raise NOT_FOUND rather than answer, so this
  // cannot pass by asserting nothing.
  const waited = await cli.runFrom(sub, [
    "wait",
    "../plan.html",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);

  // The product's own canonicalisation defines "the same session". macOS
  // symlinks the temp root (/var -> /private/var), so a path this test
  // computed would be a third opinion rather than the answer.
  expect(isAbsolute(String(opened.session))).toBe(true);
  expect(waited.session).toBe(opened.session);
  expect(basename(String(opened.session))).toBe("plan.html");
  // One session, not two that happen to share a name: the wait reports the
  // segment the open just started, from its cursor rather than a fresh log.
  expect(waited.version).toBe(opened.version);
  expect(waited.nextCursor).toBe(opened.nextCursor);

  // A stranger directory holding a file of the SAME NAME - `makeCli` writes
  // its own plan.html, which is exactly the shape needed. The bare relative
  // path must address THAT file - which has no session - rather than drifting
  // onto the ambient one an agent happens to have open elsewhere.
  stranger = await makeCli(PLAN_THEMED);

  const refusal = await stranger
    .run(["wait", "plan.html", "--timeout", waitTimeoutSeconds(1)])
    .then(
      (payload) => payload,
      (error: unknown) => error,
    );

  expect(refusal, "a stranger cwd attached to an ambient session").toBeInstanceOf(CliFailure);
  const failure = refusal as CliFailure;
  expect(failure.code).toBe(1);
  const envelope = JSON.parse(failure.stdout) as {
    error: { code: string; detail: { path: string } };
  };
  expect(envelope.error.code).toBe("NOT_FOUND");
  // Named the stranger's own file, so the refusal is about the right path.
  expect(envelope.error.detail.path).toContain(basename(stranger.dir));
  expect(envelope.error.detail.path).not.toBe(opened.session);
});

test("intent and progress refine the working window without claiming delivery", async ({
  page,
}) => {
  cli = await makeCli(PLAN_THEMED);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  await on(page).messageInput().fill("Does the backfill have to be nightly?");
  await on(page).sendMessage().click();

  // Nothing has taken delivery: the message is in the log and that is all.
  const chip = on(page).deliveryState();
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-state", "recorded");

  // `intent` and `progress` are presence, not delivery. They append an ack
  // with no `covers`, so they claim no batch.
  await cli.run(["intent", cli.artifact, "revise"]);

  // SETTLE SIGNAL, and the reason it is here: the assertion below is that
  // something did NOT change, and a polling assertion on an unchanged value
  // resolves against the frame that was already on screen - it would pass
  // before the ack had even reached the viewer. So the intent's OWN visible
  // effect is asserted first. Once the working line reads the declared intent,
  // the payload carrying that ack has been applied.
  const working = on(page).agentWorking();
  await expect(working).toBeVisible();
  await expect(working).toContainText("Updating the artifact…");

  await cli.run(["progress", cli.artifact, "--total", "3"]);
  // Same again for the second ack: the fan-out rendering is its own visible
  // effect, and it only exists once THIS ack is in the applied payload.
  await expect(working).toHaveAttribute("data-fanout", "true");
  await expect(working).toContainText("3 agents in progress");

  // Two presence acks later, the message is still only recorded. Read off the
  // same payload that just proved itself applied, so this is a fact about the
  // current frame rather than a stale one.
  await expect(chip, "a presence-only ack claimed a batch it never read").toHaveAttribute(
    "data-state",
    "recorded",
  );
});

test("re-opening an ended session starts segment 2 with a strictly greater cursor", async () => {
  cli = await makeCli(PLAN_THEMED);

  const first = await cli.run(["open", cli.artifact]);
  const heldCursor = seqOf(first.nextCursor);

  await cli.run(["end", cli.artifact]);

  const reopened = await cli.run(["open", cli.artifact]);

  // A new segment starts its own version numbering, so the agent is looking at
  // v1 again - the artifact was not edited, the lifecycle restarted.
  expect(reopened.version).toBe(1);
  expect(reopened.status).toBe("active");
  expect(reopened.session).toBe(first.session);

  // The cursor is NOT segment-scoped. An agent that persisted `heldCursor`
  // before the end must be able to use it after the reopen, which is only true
  // while seqs keep climbing across segments.
  expect(seqOf(reopened.nextCursor)).toBeGreaterThan(heldCursor);

  const status = (await cli.run([])) as {
    sessions: { session: string; segment: number; version: number }[];
  };
  const listed = status.sessions.filter((s) => s.session === reopened.session);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.segment).toBe(2);
  expect(listed[0]?.version).toBe(1);
});

test("bare lucid lists sessions in BOTH layouts, each once, at the right artifact", async () => {
  cli = await makeCli(PLAN_THEMED);
  // A second artifact in the same folder, so the listing has one session per
  // layout to find - and a miss is attributable to the layout, not the folder.
  const rollout = join(cli.dir, "rollout.html");
  await writeFile(rollout, PLAN_THEMED);
  await cli.run(["open", cli.artifact]);
  await cli.run(["open", rollout]);
  await cli.run(["end", rollout]);

  // Fabricate the legacy layout the way history did: the session folder lives
  // under `.lucid/` beside the artifact (src/core/paths.ts legacySessionDir)
  // until its next open moves it forward. Ended first, so no live server holds
  // a descriptor pointing at the old location.
  await mkdir(join(cli.dir, ".lucid"), { recursive: true });
  await rename(join(cli.dir, "rollout"), join(cli.dir, ".lucid", "rollout"));

  const status = (await cli.run([])) as { sessions: { session: string; status: string }[] };
  const paths = status.sessions.map((s) => s.session);

  // Both, once each, and each resolving to its own artifact - the legacy row
  // must not duplicate the modern one, vanish, or leak `.lucid` into the path
  // an agent would address the session by. Compared by realpath, not by
  // string: the live row reports the spelling its descriptor was opened
  // under while the legacy row is reconstructed from the scan root's cwd,
  // which the OS hands back realpathed - the same identity split the cleanup
  // comment above documents. The same FILE is the claim; one spelling is not.
  expect(paths.map((p) => realpathSync(p)).sort()).toEqual(
    [cli.artifact, rollout].map((p) => realpathSync(p)).sort(),
  );
  for (const p of paths) expect(p).not.toContain(".lucid");
  const legacyRow = status.sessions.find((s) => realpathSync(s.session) === realpathSync(rollout));
  expect(legacyRow?.status).toBe("ended");
});
