import { expect, test } from "@playwright/test";
import { makeCli, PLAN_V1, surfaceOf, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * The shipped artifact, run as a user runs it (M6.2, O).
 *
 * Every other suite drives `bun run src/cli/main.ts`, and on one point that is
 * a different program: `selfInvocation` (src/cli/self.ts) reads
 * `process.argv[1]`, which is the entry SCRIPT under bun and the first user
 * ARGUMENT in the compiled binary. It forwards the script only in the first
 * case. Get that backwards and `dist/lucid open` spawns `dist/lucid open
 * __serve <path>`, the child dies on the malformed command line, and `open`
 * fails with SERVER_ERROR after its 8s handshake window - in the artifact
 * people install, while the whole dev-mode suite stays green.
 *
 * So this is not a duplicate of the `open` tests. It is the one place the
 * binary itself is under test, which is also why `global-setup.ts` now gates
 * `dist/lucid` on the sources it is compiled from rather than on the embedded
 * bundle alone: without that, an edit to `self.ts` would leave yesterday's
 * binary on disk and this test would pass against code that is not in the
 * commit.
 */

let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

test("the compiled binary spawns its own __serve and answers", async ({ page }) => {
  cli = await makeCli(PLAN_V1, { binary: true });

  // `dist/lucid open plan.html`. The url is only printed after the detached
  // server has answered the handshake, so this line is the self-invocation
  // claim: the child was spawned with a command line it could actually run.
  const opened = (await cli.run(["open", cli.artifact])) as {
    status: string;
    url: string;
    version: number;
  };
  expect(opened.status).toBe("active");
  expect(opened.url).toContain("127.0.0.1");
  expect(opened.version).toBe(1);

  // The server the BINARY spawned is a real viewer, serving the bundle
  // compiled into it - not a process that merely opened a port.
  await page.goto(opened.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");

  // ...and it answers the binary's own reads. A `wait` that returns `waiting`
  // took the liveness handshake and found the session alive; a dead server
  // returns `suspended`, which is how this would report a spawn that only
  // looked successful.
  const idle = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(3)])) as {
    status: string;
  };
  expect(idle.status).toBe("waiting");
});
