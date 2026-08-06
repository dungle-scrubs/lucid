import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one config-path resolver (M1.8). Lucid's machine-local config files -
 * `registry.json`, `roots.json`, `settings.json` - each spelled out
 * `explicit ?? $ENV ?? ~/.lucid/<name>` separately, and none honored a
 * `LUCID_HOME` override. `configFile` owns the precedence once:
 *
 *   explicit argument  >  per-file env var  >  `LUCID_HOME`  >  `~/.lucid`
 *
 * `LUCID_HOME` relocates the whole tree, which a test or a second install
 * needs and the per-file env vars alone could not express.
 */

/** The Lucid config root: `$LUCID_HOME` if set, else `~/.lucid`. */
export const lucidHome = (): string => process.env.LUCID_HOME ?? join(homedir(), ".lucid");

/** The per-file env-var override names, as a const table. Exported (not
 *  inlined at the call sites) so the static drift scan in env-isolation.test.ts
 *  can see them: `configFile` reads `process.env[envVar]`, and a computed
 *  access is the one form that scan cannot follow. */
export const CONFIG_ENV = {
  registry: "LUCID_REGISTRY",
  roots: "LUCID_ROOTS",
  settings: "LUCID_SETTINGS",
} as const;

/** Resolve a Lucid config file by the one precedence rule. `explicit` is the
 *  caller's own argument (e.g. a `--registry` flag); `envVar` is the per-file
 *  override env-var name. */
export const configFile = (name: string, envVar: string, explicit?: string): string => {
  if (explicit !== undefined) return explicit;
  const env = process.env[envVar];
  if (env !== undefined && env !== "") return env;
  return join(lucidHome(), name);
};
