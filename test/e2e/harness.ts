import { test as base } from "@playwright/test";
import { makeCli, type Cli } from "./cli.ts";
import { startHub, type Hub, type HubOptions } from "./hub.ts";
import { PLAN_V1 } from "./fixtures.ts";

/**
 * Playwright fixtures for the two things every suite sets up by hand.
 *
 * The pattern they replace is a module-level `let cli` plus an `afterEach` that
 * remembers to clean it. That works until a test throws before the assignment,
 * or a second CLI is added and the teardown is updated for one of them, or a
 * file grows an early `return` - and the failure is a leaked `__serve` reported
 * at the end of the run, pointing at the suite rather than the test.
 *
 * `use()` teardown runs whether the test passed, failed or threw, and it runs
 * per test rather than per file, so nothing carries between them (D-022).
 *
 * Opt-in on purpose: a suite that wants a hub with `attend`, or two CLIs, or a
 * session opened a particular way, still builds its own. These cover the common
 * shape, not every shape.
 */
export const test = base.extend<{
  /** A CLI over a fresh artifact, ended and removed after the test. */
  cli: Cli;
  /** A hub on an ephemeral port with an isolated registry, stopped after. */
  hub: Hub;
  /** Same, with the attend engine running so `/hub/create` spawns. */
  attendingHub: Hub;
}>({
  // Playwright REQUIRES the first parameter to be an object destructuring
  // pattern - it reads the property names to work out which fixtures this one
  // depends on, and rejects `_deps` outright. These depend on nothing, so the
  // pattern is empty, which biome flags. The rule loses to the framework.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright parses this pattern
  cli: async ({}, use) => {
    const cli = await makeCli(PLAN_V1);
    await use(cli);
    await cli.cleanup();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright parses this pattern
  hub: async ({}, use) => {
    const hub = await startHub();
    await use(hub);
    await hub.stop();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright parses this pattern
  attendingHub: async ({}, use) => {
    const options: HubOptions = { attend: true };
    const hub = await startHub(options);
    await use(hub);
    await hub.stop();
  },
});

export { expect } from "@playwright/test";
