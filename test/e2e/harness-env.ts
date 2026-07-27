import { join } from "node:path";

/**
 * The environment every harness-spawned Lucid process runs in, and the policy
 * that says which variables have to be in it.
 *
 * The suite reads the developer's real home unless something stops it. Three of
 * these pointed at real files until this module existed: the settings the human
 * edits, and the two Claude session/project directories - so a test could read,
 * and in principle write, state belonging to whoever ran it, and its result
 * depended on what was in there. A suite whose outcome varies with the machine
 * it runs on is not measuring the product (D-011).
 *
 * The policy is the interesting half. Isolating today's variables is a one-off;
 * staying isolated as the product grows a new one is the thing worth building,
 * so every `LUCID_*` the product reads must be classified here and
 * `test/env-isolation.test.ts` fails on any that is not. Adding a variable to
 * `src/` and forgetting the harness is then a red test rather than a slow leak
 * back onto the developer's home directory.
 */

/** Why a variable does not need containing. Written out because "not in the
 *  list" is indistinguishable from "nobody thought about it". */
export type NotIsolatedReason =
  /** The product sets it FOR a child it spawns; it is an output, not config. */
  | "written-for-children"
  /** Only meaningful in dev mode, which the harness never runs. */
  | "dev-only"
  /** The harness sets it per-suite rather than globally, because suites
   *  legitimately disagree about the value. */
  | "per-suite";

export const ENV_POLICY: Readonly<Record<string, NotIsolatedReason | "isolate">> = {
  // Contained: each points at a path inside the test's own directory.
  LUCID_SETTINGS: "isolate",
  LUCID_CLAUDE_SESSIONS: "isolate",
  LUCID_CLAUDE_PROJECTS: "isolate",
  LUCID_REGISTRY: "isolate",
  LUCID_ROOTS: "isolate",
  LUCID_HARNESSES: "isolate",
  LUCID_ALLOW_TEMP: "isolate",
  LUCID_NO_OPEN: "isolate",
  LUCID_IDLE_MS: "isolate",

  // A hub the human happens to be running would hijack `open` into daemon mode
  // and change what the tests see - but shell.e2e.ts needs its OWN hub, so the
  // value differs per suite and only the presence of a decision is enforced.
  LUCID_HUB_PORT: "per-suite",
  LUCID_HUB_ROOTS: "per-suite",
  LUCID_HUB_ATTEND: "per-suite",
  // Read by ports.ts to offset every port. Left unset on purpose: the default
  // is derived from the Playwright slot, which is the isolation.
  LUCID_PORT_BASE: "per-suite",

  // Handed to a spawned agent by the product itself. Nothing reads these from
  // the developer's environment.
  LUCID_HARNESS: "written-for-children",
  LUCID_MODEL: "written-for-children",
  LUCID_EFFORT: "written-for-children",
  LUCID_SESSION_ID: "written-for-children",

  LUCID_DEV_ASSETS: "dev-only",
};

/** Variables the harness env must contain for every spawned process. */
export const MUST_ISOLATE: readonly string[] = Object.entries(ENV_POLICY)
  .filter(([, policy]) => policy === "isolate")
  .map(([name]) => name)
  .sort();

/**
 * The contained environment for a CLI invocation rooted at `dir`.
 *
 * One definition rather than an object literal per call site, so the drift test
 * has something to check and so a new containment reaches every suite at once.
 */
export const harnessEnv = (dir: string): Record<string, string> => ({
  LUCID_NO_OPEN: "1",
  LUCID_IDLE_MS: "0",
  // `open` registers every session in the hub registry; without this each run
  // leaves dead /tmp pointers in the REAL ~/.lucid/registry.json, which the
  // human's shell then lists as ghost sessions.
  LUCID_ALLOW_TEMP: "1",
  LUCID_REGISTRY: join(dir, "registry.json"),
  LUCID_ROOTS: join(dir, "roots.json"),
  // The three that used to reach the developer's real home. Pointed at paths
  // inside the test's directory that deliberately do not exist: the product
  // must cope with absent settings and an empty history, and if a test ever
  // depends on their contents it will say so by failing rather than by quietly
  // reading whatever the human happened to have.
  LUCID_SETTINGS: join(dir, "settings.json"),
  LUCID_CLAUDE_SESSIONS: join(dir, "claude-sessions"),
  LUCID_CLAUDE_PROJECTS: join(dir, "claude-projects"),
  LUCID_HARNESSES: join(dir, "harnesses.json"),
});

/**
 * A port nothing listens on, so discovery cannot find a hub.
 *
 * `LUCID_HUB_PORT` decides where `open` and the CLI look for an always-on hub.
 * Left unset, they find the one the developer is running - which then hosts the
 * session, answers the requests the test meant for its own server, and makes
 * the outcome depend on whether someone had Lucid open. Port 1 is privileged
 * and never bound, so the dedicated-server path is taken deterministically.
 */
export const DEAD_HUB_PORT = "1";
