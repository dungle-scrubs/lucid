import { on } from "./locators.ts";
import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLastAttendant } from "../../src/core/attendant.ts";
import { cursorSidecarPath, sessionPaths } from "../../src/core/paths.ts";
import { safeForkId } from "../../src/launch/seed.ts";
import { DEAD_HUB_PORT, harnessEnv } from "./harness-env.ts";
import {
  MAIN,
  makeCli,
  parsed,
  PLAN_V1,
  startCli,
  surfaceOf,
  waitTimeoutSeconds,
  type Cli,
  type Running,
} from "./helpers.ts";

/**
 * The fork launcher as a long-lived child (M5.6, stub-harness-launcher).
 *
 * `lucid launch` is the one command that SPAWNS other processes, so its
 * failures are the expensive kind: a duplicate child does the same work twice
 * and appends it twice, and an orphan holds the log lock after its parent is
 * gone. Both are invisible from inside the launcher, which is why every claim
 * here is checked against something outside it - the handled set on disk, the
 * process table, or the log.
 *
 * The harness registry points at a STUB rather than a real agent: the claims
 * here are about the launcher's own behaviour, not an agent's.
 *
 * Two of these scenarios (`launch-dedupes-handled-forks`,
 * `launch-yields-to-a-human-attendant`) were once written WITHOUT a fork and
 * measured vacuous in M5.6: with nothing in the log the launcher spawns and
 * attends nothing, so "no duplicate child" and "no resume turn" were true
 * whatever the code did - removing the dedupe check and the single-attendant
 * guard left both green. So every claim below is now made downstream of a REAL
 * fork, made from the viewer the way a human makes one, and each test first
 * proves the launcher DID act (the marker file gained a line naming the child
 * it spawned) before it claims the launcher did not act again.
 */

let cli: Cli | undefined;
/** Launchers started by a test, killed here even when it failed early - an
 *  abandoned `lucid launch` keeps polling the log for the rest of the run. */
let launchers: Running[] = [];
/** Child artifacts the launcher opened: each has its OWN detached server, which
 *  belongs to no `makeCli` and would outlive the suite. */
let children: string[] = [];

test.afterEach(async () => {
  for (const launcher of launchers) {
    launcher.child.kill("SIGINT");
    await Promise.race([launcher.done, new Promise((r) => setTimeout(r, 5000))]);
    launcher.kill(); // SIGKILL whatever ignored the interrupt
  }
  launchers = [];
  for (const child of children) await cli?.run(["end", child]).catch(() => {});
  children = [];
  await cli?.cleanup();
  cli = undefined;
});

/**
 * A harness registry whose "agent" is a shell command that exits at once -
 * enough for the launcher to spawn, wait on, and record a child.
 *
 * `authors` makes the stub do what the create prompt actually asks a real agent
 * to do: write the artifact (by copying one) and `lucid open` it. That is what
 * carries a fork past `createChild` - with no file at `{artifact}` the launcher
 * stops at `author-failed` and never enters the attend loop, which is where the
 * single-attendant guard lives.
 *
 * `attendedBy` then records a human attendant on the child through the product's
 * own path: `lucid wait --harness <name>` is what writes the
 * `cursor.<harness>.json` sidecar the guard reads. Done inside the create turn
 * so the sidecar is there before the attend loop's first pass, rather than
 * racing it.
 */
const stubRegistry = (
  marker: string,
  options: { readonly authors?: string; readonly attendedBy?: string } = {},
) => {
  const record = (verb: string): string => `echo "${verb}: $1" >> "${marker}"`;
  const lucid = `bun run ${MAIN}`;
  const create = [
    record("spawned"),
    ...(options.authors ? [`cp "${options.authors}" "$1"`, `${lucid} open "$1"`] : []),
    ...(options.attendedBy
      ? [`${lucid} wait "$1" --harness ${options.attendedBy} --timeout 0`]
      : []),
  ].join("\n");
  return {
    default: "stub",
    harnesses: {
      stub: {
        // `{artifact}` rides as an argv element rather than inside the script,
        // so each recorded line names WHICH child the turn was for - "one line
        // per fork" is otherwise indistinguishable from "two lines for one".
        spawn: ["sh", "-c", create, "--", "{artifact}"],
        resume: ["sh", "-c", record("resumed"), "--", "{artifact}"],
      },
    },
  };
};

/**
 * The environment a launcher runs in.
 *
 * `makeCli` pins `LUCID_HUB_PORT` at a dead port for its own invocations, and a
 * launcher needs the same pin for the same reason: its children run `lucid
 * open`, which prefers a running hub - so on a machine where the developer has
 * one, the child session would be handed to THEIR shell instead of getting the
 * dedicated server this suite reads `server.json` for.
 */
const launcherEnv = (dir: string): Record<string, string> => ({
  ...harnessEnv(dir),
  LUCID_HUB_PORT: DEAD_HUB_PORT,
});

/** The lines the stub recorded - one per turn the launcher actually ran. */
const turns = async (marker: string): Promise<string[]> =>
  readFile(marker, "utf8").then(
    (text) => text.split("\n").filter((line) => line.trim().length > 0),
    () => [], // not yet created: no turn has run
  );

/** Fork ids in the parent's log, in order - the evidence that a fork the
 *  launcher could see actually exists. */
const forkIds = async (dir: string): Promise<string[]> => {
  const raw = await readFile(join(dir, "plan", "log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { t: string; id?: string })
    .filter((event) => event.t === "fork")
    .map((event) => event.id ?? "");
};

/** Spin a region of the artifact off, from the viewer, the way a human does. */
const forkFrom = async (page: Page, selector: string, note: string): Promise<void> => {
  await surfaceOf(page).locator(selector).click();
  await on(page).annotationNote().fill(note);
  await on(page).fork().click();
  await expect(on(page).annotationNote()).toHaveCount(0);
};

test("launch without a session refuses before it reads the registry", async () => {
  cli = await makeCli(PLAN_V1);
  // No `open` first. The order matters: a launcher that read the registry
  // before checking the session would report a missing registry for an
  // artifact that has no session at all, sending the human to fix the wrong
  // thing.
  const failed = await cli.run(["launch", cli.artifact]).then(
    () => undefined,
    (error: unknown) => error as { stdout: string; code: number | null },
  );
  expect(failed).toBeDefined();
  const envelope = parsed<{ error?: { code?: string; message?: string } }>(failed?.stdout ?? "");
  expect(envelope?.error?.code).toBe("NOT_FOUND");
  expect(envelope?.error?.message).toContain("No Lucid session");
});

test("SIGINT stops the launcher without orphaning a child or the parent session", async () => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  expect(session.url).toContain("127.0.0.1");

  const marker = join(cli.dir, "spawns.log");
  await writeFile(join(cli.dir, "harnesses.json"), JSON.stringify(stubRegistry(marker), null, 2));

  const launcher = startCli(cli.dir, ["launch", cli.artifact]);
  await new Promise((r) => setTimeout(r, 3000));
  launcher.child.kill("SIGINT");

  // It EXITS - a launcher that ignores SIGINT is one a human cannot stop
  // without hunting for its pid.
  const result = await Promise.race([
    launcher.done,
    new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
  ]);
  expect(result, "the launcher did not exit within 15s of SIGINT").not.toBeNull();

  // ...and the PARENT session is still usable afterwards, which is the thing
  // an orphan holding the log lock would have broken. `wait` answering at all
  // means the lock is free and the log is readable.
  const after = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(2)])) as {
    status: string;
  };
  expect(["waiting", "feedback", "suspended"]).toContain(after.status);
});

test("a restarted launcher does not re-spawn a fork it already handled", async ({ page }) => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const dir = cli.dir;
  const artifact = cli.artifact;
  const session = (await cli.run(["open", artifact])) as { url: string };
  const marker = join(dir, "spawns.log");
  await writeFile(join(dir, "harnesses.json"), JSON.stringify(stubRegistry(marker), null, 2));

  // A REAL fork, made from the viewer. Everything below is vacuous without one:
  // a launcher watching a forkless log spawns nothing whatever its dedupe code
  // says, which is exactly how this scenario passed while it tested nothing.
  await page.goto(session.url);
  await forkFrom(page, 'li[data-lucid-id="step-backfill"]', "Spin the backfill out on its own.");
  await expect.poll(() => forkIds(dir)).toHaveLength(1);
  const [firstFork = ""] = await forkIds(dir);

  // The first run DEMONSTRABLY spawns: one recorded turn, naming this fork's
  // child. Without this line the restart claim is unfalsifiable.
  const first = startCli(dir, ["launch", artifact, "--poll", "300"], launcherEnv(dir));
  launchers.push(first);
  await expect
    .poll(() => turns(marker), { message: "the launcher never spawned for the fork in the log" })
    .toHaveLength(1);
  expect((await turns(marker))[0]).toContain(safeForkId(firstFork));

  // ...and records it as handled, on disk, before the process goes away. That
  // file is the only thing the next launcher can read.
  first.child.kill("SIGINT");
  await first.done;
  launchers = launchers.filter((l) => l !== first);
  const handled = JSON.parse(
    await readFile(join(dir, "plan", "forks", "handled.json"), "utf8"),
  ) as string[];
  expect(handled).toContain(firstFork);

  // A SECOND fork, so the restarted launcher has genuine work to do. It is what
  // makes "the marker did not grow" mean "it skipped the old fork" rather than
  // "it never got as far as spawning anything" - a launcher that crashed on
  // start would satisfy a bare no-growth assertion perfectly.
  await forkFrom(page, "#note", "And spin the downtime note out too.");
  await expect.poll(() => forkIds(dir)).toHaveLength(2);
  const ids = await forkIds(dir);

  const second = startCli(dir, ["launch", artifact, "--poll", "300"], launcherEnv(dir));
  launchers.push(second);
  await expect
    .poll(() => turns(marker), { message: "the restarted launcher never spawned the NEW fork" })
    .toHaveLength(2);
  // Several more poll cycles: a re-spawn of the first fork would arrive on any
  // of them, and the count above could have been read in the gap before it.
  await new Promise((r) => setTimeout(r, 2000));

  const recorded = await turns(marker);
  expect(recorded, "the launcher re-spawned a fork it had already handled").toHaveLength(2);
  // One turn per fork, not two for either: a duplicate child does the agent's
  // work twice and appends it twice.
  for (const id of ids) {
    expect(recorded.filter((line) => line.includes(safeForkId(id)))).toHaveLength(1);
  }
});

test("the launcher yields a child a human is attending and drives no resume turn", async ({
  page,
}) => {
  test.slow();
  cli = await makeCli(PLAN_V1);
  const dir = cli.dir;
  const artifact = cli.artifact;
  const session = (await cli.run(["open", artifact])) as { url: string };
  const marker = join(dir, "spawns.log");
  // The stub AUTHORS and opens the child, then a human harness takes attendance
  // of it. Both halves are needed: without a child there is no attend loop to
  // guard, and without an attendant record there is nothing to yield to - which
  // together are why this scenario measured vacuous before.
  await writeFile(
    join(dir, "harnesses.json"),
    JSON.stringify(stubRegistry(marker, { authors: artifact, attendedBy: "claude-code" }), null, 2),
  );

  await page.goto(session.url);
  await forkFrom(page, 'li[data-lucid-id="step-backfill"]', "Spin the backfill out on its own.");
  await expect.poll(() => forkIds(dir)).toHaveLength(1);
  const [forkId = ""] = await forkIds(dir);

  // Where the launcher will put this fork's child - the same derivation
  // `childArtifactPath` uses, so its session (and its detached server) can be
  // found and cleaned up whatever the test goes on to assert.
  const parent = sessionPaths(artifact);
  const childArtifact = join(parent.artifactDir, `${parent.name}-fork-${safeForkId(forkId)}.html`);
  const child = sessionPaths(childArtifact);
  children.push(childArtifact);

  const launcher = startCli(dir, ["launch", artifact, "--poll", "300"], launcherEnv(dir));
  launchers.push(launcher);
  let said = "";
  launcher.child.stdout?.on("data", (chunk: Buffer) => {
    said += chunk.toString();
  });

  // The launcher genuinely got this far: it ran the create turn and opened the
  // child. Everything after this is about a child that exists.
  await expect
    .poll(() => turns(marker), { message: "the launcher never spawned a child for the fork" })
    .toHaveLength(1);
  await expect
    .poll(() => said, { message: "the launcher never opened the child it authored" })
    .toContain(`opened ${child.name}`);
  // ...and the human's attendance really is on disk, in the record the guard
  // reads. A yield asserted against an absent attendant is the vacuum again.
  const attendant = await readLastAttendant(child);
  expect(
    attendant?.harness,
    `no attendant sidecar at ${cursorSidecarPath(child, "claude-code")}`,
  ).toBe("claude-code");

  // It yields on OWNERSHIP, before any feedback exists to fight over. A guard
  // that only fires once a batch has arrived has already held the child through
  // the window where the human was typing into it.
  await expect
    .poll(() => said, { message: "the launcher never yielded the child to the human attendant" })
    .toMatch(/yielding to "claude-code" \(human attached\)/);

  // Now the human sends feedback in the child's own viewer.
  const descriptor = JSON.parse(await readFile(child.serverJson, "utf8")) as { port: number };
  await page.goto(`http://127.0.0.1:${descriptor.port}/__lucid/viewer`);
  await on(page).messageInput().fill("Make the backfill plan concrete about batch size.");
  await on(page).sendMessage().click();
  await expect(page.locator('[data-role="human"]')).toContainText("batch size");

  // The attending human is the one who gets it...
  const batch = (await cli.run(["wait", childArtifact, "--timeout", waitTimeoutSeconds(8)])) as {
    status: string;
    messages?: { role: string; text: string }[];
  };
  expect(batch.status).toBe("feedback");
  expect(batch.messages?.some((m) => m.role === "human" && m.text.includes("batch size"))).toBe(
    true,
  );

  // ...and the launcher never drove a turn of its own. Given a settle window,
  // because the failure this rules out is a resume turn arriving late, on top
  // of whatever the human is already doing.
  await new Promise((r) => setTimeout(r, 2000));
  const recorded = await turns(marker);
  expect(
    recorded.filter((line) => line.startsWith("resumed:")),
    "the launcher drove a resume turn on a child a human is attending",
  ).toHaveLength(0);
  expect(recorded).toHaveLength(1);
});
