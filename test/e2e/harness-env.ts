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

/** Why a variable does not need pointing at a path inside the test's dir.
 *  Written out because "not in the list" is indistinguishable from "nobody
 *  thought about it". */
export type NotIsolatedReason =
  /** Not a path: a behaviour flag the harness pins for processes it SPAWNS.
   *  Leaving it unset reads no state off the developer's disk, so the unit
   *  suite - which spawns almost nothing - has no reason to pin it. */
  | "harness-switch"
  /** The product WRITES it for a child it spawns AND reads it back off its own
   *  environment, so an inherited value is somebody else's identity. Removed
   *  from the child env rather than pointed anywhere. */
  | "clear"
  /** The harness sets it per-suite rather than globally, because suites
   *  legitimately disagree about the value. */
  | "per-suite";

export const ENV_POLICY: Readonly<Record<string, NotIsolatedReason | "isolate">> = {
  // Contained: each points at a path inside the test's own directory. Unset,
  // every one of them resolves into the real home of whoever ran the suite.
  LUCID_SETTINGS: "isolate",
  LUCID_CLAUDE_SESSIONS: "isolate",
  LUCID_CLAUDE_PROJECTS: "isolate",
  // The Codex rollout store (plan 03): same shape as the Claude stores -
  // unset, corroboration reads the developer's real ~/.codex/sessions.
  LUCID_CODEX_SESSIONS: "isolate",
  LUCID_REGISTRY: "isolate",
  LUCID_ROOTS: "isolate",
  LUCID_HARNESSES: "isolate",
  // The hub's rotating request log (plan 07, D-009). Unset, every spawned hub
  // appends to the developer's real ~/.lucid/hub.log - and parallel workers
  // sharing one file can misrotate away the retained generation.
  LUCID_HUB_LOG: "isolate",

  LUCID_ALLOW_TEMP: "harness-switch",
  LUCID_NO_OPEN: "harness-switch",
  // The D-015 observability seam: when set, every would-be browser launch
  // is recorded instead of being merely suppressed. Per-suite, because only
  // the suites that ASK what open would have done set it.
  LUCID_OPEN_LOG: "per-suite",
  LUCID_IDLE_MS: "harness-switch",

  // A hub the human happens to be running would hijack `open` into daemon mode
  // and change what the tests see - but shell.e2e.ts needs its OWN hub, so the
  // value differs per suite and only the presence of a decision is enforced.
  LUCID_HUB_PORT: "per-suite",
  // The D-015 reconnect-backoff cap: a suite that kills streams on purpose
  // sets it on the processes IT spawns; everything else runs production
  // patience. Presence of a decision is what the policy enforces.
  // Internal narration (plan 07, M3.1). Cleared, not isolated: it is a
  // behaviour switch, not a path, and a developer debugging anchors in their
  // own shell must not make every spawned child in the suite loud - the
  // narration lands in each session's server.out.log, which some suites read.
  LUCID_VERBOSE: "clear",

  LUCID_SSE_MAX_BACKOFF_MS: "per-suite",
  // The M3.1 eviction seam: the connected-stream cap, lowered only by the
  // suite that proves an evicted tab's badge survives its stream.
  LUCID_STREAM_CAP: "per-suite",
  LUCID_HUB_ROOTS: "per-suite",
  LUCID_HUB_ATTEND: "per-suite",
  // Read by ports.ts to offset every port. Left unset on purpose: the default
  // is derived from the Playwright slot, which is the isolation.
  LUCID_PORT_BASE: "per-suite",

  // Written for children by `src/launch/launcher.ts` - and read straight back
  // off the environment by `attendantStamp` (src/cli/run.ts:63-69), which is
  // what makes an inherited one dangerous rather than merely untidy. The Lucid
  // skill exports LUCID_HARNESS and LUCID_SESSION_ID into the agent's shell, so
  // a suite launched from an agent session that has used Lucid stamps every
  // artifact it opens with the DEVELOPER's harness and their real session UUID.
  // That stamp then feeds presenceFor, the "conversation is open" panel and the
  // resume command - the outcome of the run changes with who started it.
  LUCID_HARNESS: "clear",
  LUCID_MODEL: "clear",
  LUCID_EFFORT: "clear",
  LUCID_SESSION_ID: "clear",
  // Who vouches for that id (plan 03). Rides with LUCID_SESSION_ID and dies
  // with it: an inherited authority without the launch it belongs to is a
  // false claim of provenance.
  LUCID_SESSION_ID_AUTHORITY: "clear",
  // The launch this process IS (plan 03). Inherited from the developer's
  // shell it would correlate a test's turns with a launch that never spawned
  // them - same false-correlation shape as LUCID_REQUEST_ID.
  LUCID_LAUNCH_ID: "clear",
  // Written for spawned turns by the hub's create path (plan 07, M1.3) and
  // read back by cliRequestId, which joins a turn's hub calls to the click
  // that spawned it. Inherited from a developer's agent session, it would
  // stamp every request this suite makes with THAT session's stale id -
  // false correlation, same failure shape as LUCID_SESSION_ID.
  LUCID_REQUEST_ID: "clear",
  // The turn a spawned process IS (plan 08, D-013): the hub mints it, exports
  // it, and names it again when it appends the terminator on exit. Inherited
  // from a developer's own agent session, every ack this suite writes would
  // join THAT turn - so a terminator would close a window the suite never
  // opened. Same false-correlation shape as LUCID_REQUEST_ID.
  LUCID_TURN_ID: "clear",

  // `devAssetsDir()` (src/server/dev-assets.ts:17) reads this on EVERY asset
  // request in every server, with no dev-mode gate of any kind. Left inherited,
  // a developer who still has it exported from `bun run dev` serves the suite
  // dist/chrome.js off their disk instead of the bundle compiled into this
  // commit - which silently voids the freshness gate 867520e exists to provide.
  LUCID_DEV_ASSETS: "clear",

  // The view opt-in (plan 06). Cleared, not isolated, and the reason is the
  // integration contract's own instruction: every chat-desktop harness EXPORTS
  // `LUCID_VIEW=solo` into the agent's shell. A developer running this suite
  // from such a session would flip every `open` in it onto the solo view - a
  // different URL and no browser launch - and the suite would be measuring
  // their harness rather than this commit.
  LUCID_VIEW: "clear",
};

/**
 * Variables that must point inside the test's own directory.
 *
 * Also what the unit suite's preload pins, which is the reason this is a
 * separate list from "everything harnessEnv sets": these are the names whose
 * absence means "read the developer's real home", and they are dangerous in
 * any process, spawned or not. A behaviour switch is not.
 */
export const MUST_ISOLATE: readonly string[] = Object.entries(ENV_POLICY)
  .filter(([, policy]) => policy === "isolate")
  .map(([name]) => name)
  .sort();

/** Every variable `harnessEnv` is responsible for setting on a spawned process. */
export const HARNESS_ENV_NAMES: readonly string[] = Object.entries(ENV_POLICY)
  .filter(([, policy]) => policy === "isolate" || policy === "harness-switch")
  .map(([name]) => name)
  .sort();

/** Variables that must not survive from the parent environment into a spawned
 *  process at all. */
export const MUST_CLEAR: readonly string[] = Object.entries(ENV_POLICY)
  .filter(([, policy]) => policy === "clear")
  .map(([name]) => name)
  .sort();

/**
 * The COMPLETE environment for a harness-spawned Lucid process rooted at `dir`.
 *
 * Takes the parent environment rather than being spread over it, because
 * removal is half the job: a variable the product reads back off its own
 * environment cannot be contained by adding a key, only by not passing one.
 * (Setting it empty would work today - every reader happens to treat "" as
 * absent - but that is a property of five call sites, not of the harness, and
 * the next reader is not bound by it.)
 *
 * One definition rather than an object literal per call site, so the drift test
 * has something to check and so a new containment reaches every suite at once.
 */
export const harnessEnv = (
  dir: string,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !MUST_CLEAR.includes(name)) env[name] = value;
  }
  return {
    ...env,
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
    LUCID_CODEX_SESSIONS: join(dir, "codex-sessions"),
    LUCID_HARNESSES: join(dir, "harnesses.json"),
    LUCID_HUB_LOG: join(dir, "hub.log"),
  };
};

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
