import { expect, test } from "@playwright/test";
import { CliFailure } from "../cli-result.ts";
import { makeCli, waitTimeoutSeconds, type Cli } from "../helpers.ts";

/**
 * M4.1 - a garbage `--since` is refused, not silently bootstrapped.
 *
 * `parseCursor` answers `undefined` for anything it cannot read, and
 * `undefined` is also the bootstrap read - full folded state, no ack. So a
 * typo'd cursor silently replayed the whole session AS A DELTA: the agent
 * re-applied every annotation and the viewer never flipped to "delivered",
 * with nothing anywhere saying why.
 *
 * Written after the fix, so RED was proved by mutation rather than observed:
 * neutralise the refusal in `runWait` and the garbage cursor below answers
 * with the full state and exit 0.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

test("a garbage --since is a VALIDATION_ERROR, not a silent full replay", async () => {
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  await cli.run(["open", cli.artifact]);

  const refused = await cli
    .run(["wait", cli.artifact, "--since", "not-a-cursor", "--timeout", waitTimeoutSeconds(1)])
    .then(
      () => undefined,
      (error: unknown) => error as CliFailure,
    );

  expect(refused, "wait accepted a cursor that parses to nothing").toBeInstanceOf(CliFailure);
  expect(refused?.code).toBe(1);
  // The refusal is in the contract's one dialect, and it names the input - an
  // agent that logged it can see what it sent.
  const envelope = JSON.parse(refused?.stdout ?? "{}") as {
    error?: { code?: string; message?: string };
  };
  expect(envelope.error?.code).toBe("VALIDATION_ERROR");
  expect(envelope.error?.message).toContain("not-a-cursor");

  // The control, both ways. A REAL cursor still waits and returns;
  // NO cursor is still the bootstrap read. The refusal must not have
  // swallowed either legitimate form.
  const real = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(1)])) as {
    nextCursor: string;
  };
  const drained = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    real.nextCursor,
    "--timeout",
    waitTimeoutSeconds(1),
  ])) as { status: string };
  expect(drained.status).toBe("waiting");
});
