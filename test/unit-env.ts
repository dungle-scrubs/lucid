import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEAD_HUB_PORT, harnessEnv, MUST_CLEAR, MUST_ISOLATE } from "./e2e/harness-env.ts";

/**
 * The unit suite's own containment: what `test/preload.ts` installs before any
 * test file loads, and what a test puts back after borrowing one of these
 * variables for itself.
 *
 * Separate from the preload because the two need different things from it. The
 * preload needs it applied once, at process start. A test needs to RESTORE it -
 * and the obvious teardown, `delete process.env.LUCID_CLAUDE_SESSIONS`, now
 * removes the containment rather than the test's own value, leaving everything
 * that runs afterwards pointed back at the developer's real home. `delete` was
 * the correct teardown when nothing owned the baseline. Something does now.
 *
 * The values come from `harnessEnv`, the same definition the e2e harness spawns
 * with, so the two suites cannot drift apart on what containment means.
 */

const dir = mkdtempSync(join(tmpdir(), "lucid-unit-env-"));

/** The contained values, fixed for the lifetime of this test process. */
export const UNIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    MUST_ISOLATE.map((name) => [name, harnessEnv(dir)[name]] as const).filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined,
    ),
  ),
  // `LUCID_HUB_PORT` decides where `open`, `deliver` and the CLI look for an
  // always-on hub. Left as the developer left it, they find the one they are
  // running - which then hosts the session, answers requests the test meant for
  // its own server, and makes the result depend on whether somebody had Lucid
  // open. Port 1 is privileged and never bound, so the dedicated-server path is
  // taken deterministically.
  LUCID_HUB_PORT: DEAD_HUB_PORT,
});

/**
 * Point this process's environment at the contained values, and remove the
 * names an inherited value would corrupt.
 *
 * Assignment, not `??=`: a value inherited from the developer's shell is the
 * thing being contained, not a decision to respect. A test that wants its own
 * value sets it directly and calls this again when it is done.
 */
export const applyUnitEnv = (): void => {
  for (const [name, value] of Object.entries(UNIT_ENV)) process.env[name] = value;
  // Identity the product both writes for its children and reads back off its
  // own environment: inherited, it stamps this suite's artifacts with the
  // developer's harness and their real session UUID.
  for (const name of MUST_CLEAR) delete process.env[name];
};
