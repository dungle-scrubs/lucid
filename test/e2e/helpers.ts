/**
 * The harness, as one import.
 *
 * A barrel over the capability modules (D-014): `cli.ts`, `hub.ts`, `visual.ts`,
 * `fixtures.ts`, `routes.ts`, plus `kill-server.ts` and `cli-result.ts`. Suites
 * import from here; the modules are where the code lives and where a change
 * belongs.
 *
 * Kept deliberately: 12 suites import this path, and rewriting them all to
 * spell out five modules would be a large diff that changes nothing about what
 * runs. The split is for the people editing the harness, not for its callers.
 */
export { killSessionServer } from "./kill-server.ts";
export { interpretCliResult, type CliOutcome } from "./cli-result.ts";
// Named, not `export *`: `invoke` takes a raw `env` and bypasses `makeCli`'s
// `harnessEnv`, so publishing it here would hand every future test the one
// function that can read the developer's real home. `hub.ts` imports it
// directly, which is the only caller that should.
export { MAIN, makeCli, waitTimeoutSeconds, type Cli } from "./cli.ts";
export * from "./hub.ts";
export * from "./visual.ts";
export * from "./fixtures.ts";
export * from "./routes.ts";
export * from "./concurrent.ts";
export * from "./scale.ts";
