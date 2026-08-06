/**
 * The shared LUCID_* environment variable ↔ attendant stamp field table (M5.5).
 *
 * One source of truth for how a spawn's identity (SpawnIdentity) maps to the
 * LUCID_* environment variables a child reads, and how those variables map
 * back to an AttendantStamp. Both `spawn.ts` (writer) and `ack.ts` (reader)
 * import this table so the mapping appears in exactly one place.
 *
 * Each entry names the env var, the stamp field it carries, and whether it is
 * cleared when no identity is passed (a fork-child spawn that must not inherit
 * its parent's identity).
 */

/** The env vars a spawn writes for its child, and their stamp field names. */
export const LUCID_ENV_FIELDS = {
  harness: "LUCID_HARNESS",
  sessionId: "LUCID_SESSION_ID",
  sessionIdAuthority: "LUCID_SESSION_ID_AUTHORITY",
  launchId: "LUCID_LAUNCH_ID",
  model: "LUCID_MODEL",
  effort: "LUCID_EFFORT",
  trace: "LUCID_REQUEST_ID",
  turnId: "LUCID_TURN_ID",
} as const;

/** The hub port env var (not a stamp field; used for `lucid open`). */
export const LUCID_HUB_PORT = "LUCID_HUB_PORT";

/** The non-identity environment a spawned child needs (M2.7): the hub port a
 *  `lucid open` inside the turn dials back. Rides a unit here rather than as
 *  a trailing arg or a stamp field, so the launch-env surface has one home
 *  (a registry-source field joins it when the CLI needs to pass one). */
export interface LaunchEnv {
  readonly hubPort?: number;
}

/** Every LUCID_* env var that must be CLEARED when no identity is passed,
 *  so a fork child does not inherit its parent's identity. */
export const LUCID_CLEAR_KEYS = Object.values(LUCID_ENV_FIELDS);

/** Build the env object a spawn injects. Sets each LUCID_* from the identity
 *  fields, or clears them all when no identity is passed. Used by spawn.ts
 *  (the writer); ack.ts's attendantStamp reads the same vars back. */
export const buildSpawnEnv = (
  identity: {
    readonly harness: string;
    readonly sessionId?: string;
    readonly sessionIdAuthority?: string;
    readonly launchId?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly requestId?: string;
    readonly turnId?: string;
  } | null,
  discovered: boolean,
  launchEnv?: LaunchEnv,
): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(identity
    ? {
        [LUCID_ENV_FIELDS.harness]: identity.harness,
        [LUCID_ENV_FIELDS.sessionId]: discovered ? undefined : identity.sessionId,
        [LUCID_ENV_FIELDS.sessionIdAuthority]:
          !discovered && identity.sessionId ? "assigned" : identity.sessionIdAuthority,
        [LUCID_ENV_FIELDS.launchId]: identity.launchId,
        [LUCID_ENV_FIELDS.model]: identity.model,
        [LUCID_ENV_FIELDS.effort]: identity.effort,
        [LUCID_ENV_FIELDS.trace]: identity.requestId,
        [LUCID_ENV_FIELDS.turnId]: identity.turnId,
        ...(launchEnv?.hubPort !== undefined
          ? { [LUCID_HUB_PORT]: String(launchEnv.hubPort) }
          : {}),
      }
    : Object.fromEntries(LUCID_CLEAR_KEYS.map((k) => [k, undefined]))),
});
