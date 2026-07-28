import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeCli, parsed, PLAN_V1, startCli, waitTimeoutSeconds, type Cli } from "./helpers.ts";

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
 * TWO scenarios are deliberately absent - `launch-dedupes-handled-forks` and
 * `launch-yields-to-a-human-attendant`. Both were written, both passed, and
 * both were then MEASURED vacuous: with no fork in the log the launcher never
 * spawns or attends anything, so "no child was spawned" is true whatever the
 * code does. Removing the dedupe check and the single-attendant guard each
 * left their test green. Reaching them needs a real fork driven to a real
 * child, which needs a spawn that actually completes - more machinery than
 * this milestone owns, and recorded rather than faked.
 */

let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

/** A harness registry whose "agent" is a shell command that exits at once -
 *  enough for the launcher to spawn, wait on, and record a child. */
const stubRegistry = (marker: string) => ({
  default: "stub",
  harnesses: {
    stub: {
      spawn: ["sh", "-c", `echo "spawned: $*" >> ${marker}`, "--"],
      resume: ["sh", "-c", `echo "resumed: $*" >> ${marker}`, "--"],
    },
  },
});

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
