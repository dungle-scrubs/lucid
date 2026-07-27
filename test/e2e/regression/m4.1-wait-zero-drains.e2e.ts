import { expect, test } from "@playwright/test";
import { makeCli, type Cli } from "../helpers.ts";

/**
 * M4.1 - `wait --timeout 0` drains and returns instead of blocking forever.
 *
 * `timeoutMs > 0 ? Date.now() + timeoutMs : POSITIVE_INFINITY` read a zero as
 * "never time out" - the one meaning nobody writing `0` intends - and parked
 * the agent's turn until somebody killed the process. The contract now: one
 * read of the log, feedback if there is any, `waiting` if not, return either
 * way.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * restore the old ternary in `src/core/wait.ts` and the run below dies on the
 * harness's own exec deadline instead of returning.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

test("wait --timeout 0 drains and returns instead of blocking forever", async () => {
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  const opened = (await cli.run(["open", cli.artifact])) as { nextCursor: string };

  // Nothing is pending past this cursor, so a drain has nothing to hand over:
  // the only correct answers are a fast `waiting` or an explicit refusal of 0,
  // and the contract picked the drain. The 30s exec deadline is the harness's,
  // not the scenario's - it is what turns "blocks forever" into a red test.
  const drained = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    opened.nextCursor,
    "--timeout",
    "0",
  ])) as { status: string; nextCursor: string };

  expect(drained.status).toBe("waiting");
  // A drain is still a real read: it reports where the log stands.
  expect(drained.nextCursor).toBeDefined();
});
