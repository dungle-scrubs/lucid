import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";

/**
 * The spawn-recipe registry: how the launcher stays agent-agnostic. Launching a
 * process is inherently harness-specific, so that knowledge lives here as data a
 * harness (or the user) declares once - never as a launch command compiled into
 * Lucid. The launcher looks up the recipe for the parent session's recorded
 * harness, substitutes the fork's parameters, and runs it. A harness with no
 * recipe simply has no headless spawn; the fork degrades to the copy-command.
 *
 * File: `$LUCID_HARNESSES` or `$XDG_CONFIG_HOME/lucid/harnesses.json` (default
 * `~/.config/lucid/harnesses.json`). Absent file = the launcher is off.
 */

/** The placeholders a recipe's argv may reference, filled per fork. */
export type RecipeVar = "id" | "seed" | "artifact" | "cwd" | "prompt";

const RECIPE_VARS: readonly RecipeVar[] = ["id", "seed", "artifact", "cwd", "prompt"];

export interface SpawnRecipe {
  /**
   * The CREATE turn's argv template: launch a fresh headless session that
   * authors the new artifact. Element 0 is the executable; every element may
   * contain `{id}` (new harness session id), `{seed}` (path to the fork seed
   * file), `{artifact}` (path the agent must write + `lucid open`), `{cwd}`
   * (project root), and `{prompt}` (the task instruction Lucid composes).
   * Passed to the OS as argv, so no shell quoting is involved - the allowlist
   * and flags are the recipe's own tokens.
   */
  readonly spawn: readonly string[];
  /**
   * The REVISE turn's argv template (shape-C liveness): re-drive the SAME
   * session (`{id}`) to apply a batch of review feedback. Same placeholders,
   * with `{prompt}` carrying the feedback. Omit it and a forked artifact is
   * one-shot - created, but not re-driven by the launcher on later feedback.
   */
  readonly resume?: readonly string[];
}

export interface HarnessRegistry {
  /** Recipe to use when the parent session's harness is unknown/unlisted. */
  readonly default?: string;
  readonly harnesses: Readonly<Record<string, SpawnRecipe>>;
}

/** Resolved location of the registry file (env override wins, then XDG). */
export const registryPath = (): string => {
  if (process.env.LUCID_HARNESSES) return process.env.LUCID_HARNESSES;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "lucid", "harnesses.json");
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const parseRegistry = (raw: string, path: string): HarnessRegistry => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError({
      message: `harness registry is not valid JSON: ${(err as Error).message}`,
      detail: { path },
    });
  }
  if (typeof data !== "object" || data === null) {
    throw new ValidationError({
      message: "harness registry must be a JSON object",
      detail: { path },
    });
  }
  const record = data as Record<string, unknown>;
  const rawHarnesses = record.harnesses;
  if (typeof rawHarnesses !== "object" || rawHarnesses === null) {
    throw new ValidationError({
      message: "harness registry needs a `harnesses` object",
      detail: { path },
    });
  }
  const harnesses: Record<string, SpawnRecipe> = {};
  for (const [name, value] of Object.entries(rawHarnesses)) {
    const spawn = (value as { spawn?: unknown })?.spawn;
    if (!isStringArray(spawn) || spawn.length === 0 || (spawn[0] ?? "").trim() === "") {
      throw new ValidationError({
        message: `harness "${name}" needs a non-empty string[] \`spawn\` (argv) with an executable`,
        detail: { path, harness: name },
      });
    }
    const resume = (value as { resume?: unknown })?.resume;
    if (resume !== undefined && (!isStringArray(resume) || resume.length === 0)) {
      throw new ValidationError({
        message: `harness "${name}" \`resume\` must be a non-empty string[] (argv) when present`,
        detail: { path, harness: name },
      });
    }
    harnesses[name] = { spawn, ...(resume ? { resume } : {}) };
  }
  const def = typeof record.default === "string" ? record.default : undefined;
  if (def !== undefined && !harnesses[def]) {
    throw new ValidationError({
      message: `registry default "${def}" is not a defined harness`,
      detail: { path, default: def },
    });
  }
  return { ...(def !== undefined ? { default: def } : {}), harnesses };
};

/** Load + validate the registry. Returns null when the file is absent (the
 *  launcher is simply not configured); throws on a present-but-malformed file
 *  so a typo is a loud error, not a silently-off feature. */
export const loadRegistry = async (path = registryPath()): Promise<HarnessRegistry | null> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return parseRegistry(raw, path);
};

/** The recipe for a harness: the named one if listed, else the registry
 *  default. Returns the resolved name alongside so callers can log which ran. */
export const resolveRecipe = (
  registry: HarnessRegistry,
  harness?: string,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined => {
  const name = harness && registry.harnesses[harness] ? harness : registry.default;
  if (!name) return undefined;
  const recipe = registry.harnesses[name];
  return recipe ? { name, recipe } : undefined;
};

/** Substitute `{var}` placeholders in an argv template (a recipe's `spawn` or
 *  `resume`). Unknown `{tokens}` are left verbatim; a declared var with no value
 *  substitutes empty. */
export const buildArgv = (
  template: readonly string[],
  subs: Readonly<Partial<Record<RecipeVar, string>>>,
): string[] =>
  template.map((tok) =>
    tok.replace(/\{([a-z]+)\}/g, (whole, key: string) =>
      RECIPE_VARS.includes(key as RecipeVar) ? (subs[key as RecipeVar] ?? "") : whole,
    ),
  );
