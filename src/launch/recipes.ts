import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { canonicalHarness } from "./selection.ts";

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

/** One model a harness offers for headless turns (registry v2, additive).
 *  `efforts` is the model's OWN effort vocabulary when it differs from the
 *  harness-wide ladder (codex enforces per-model-generation subsets). */
export interface HarnessModel {
  readonly id: string;
  /** Display name for pickers; the id is shown when absent. */
  readonly label?: string;
  /** Effort levels THIS model accepts; falls back to the recipe's `efforts`. */
  readonly efforts?: readonly string[];
}

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
  /** Curated models the harness may run headless turns on (registry v2,
   *  additive). A recipe with no models simply has no model picker. */
  readonly models?: readonly HarnessModel[];
  /** The model preselected in pickers; must be one of `models`. */
  readonly defaultModel?: string;
  /** Harness-wide effort ladder, used when a model declares no `efforts` of
   *  its own (pi normalizes one ladder across every model). */
  readonly efforts?: readonly string[];
  /** The effort preselected in pickers; must be in the ladder that applies
   *  (the default model's `efforts`, else the harness-wide `efforts`). */
  readonly defaultEffort?: string;
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

/** A declared effort ladder: non-empty string[], no blank levels. */
const isEffortList = (v: unknown): v is string[] =>
  isStringArray(v) && v.length > 0 && v.every((e) => e.trim() !== "");

/**
 * Validate a harness entry's model/effort declarations (registry v2). All
 * optional - an entry without them is exactly a v1 recipe - but a PRESENT
 * declaration that is malformed or self-inconsistent (a defaultModel not in
 * its own list) throws with the file's path: a typo'd registry must fail at
 * load, not surface later as a picker offering a model the CLI rejects.
 */
const parseSelectionFields = (
  name: string,
  value: Record<string, unknown>,
  path: string,
): Pick<SpawnRecipe, "models" | "defaultModel" | "efforts" | "defaultEffort"> => {
  const fail = (message: string): never => {
    throw new ValidationError({ message, detail: { path, harness: name } });
  };
  // Same discipline, one step earlier: the adapter knows model/effort flags for
  // a fixed set of harnesses, and a declaration on any other one can only ever
  // render a picker whose every pick is refused at spawn.
  if (
    canonicalHarness(name) === undefined &&
    (value.models !== undefined ||
      value.efforts !== undefined ||
      value.defaultModel !== undefined ||
      value.defaultEffort !== undefined)
  ) {
    fail(`harness "${name}" declares models/efforts, but Lucid knows no such flags for it`);
  }
  let models: HarnessModel[] | undefined;
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length === 0) {
      fail(`harness "${name}" \`models\` must be a non-empty array when present`);
    }
    models = [];
    const seen = new Set<string>();
    for (const raw of value.models as unknown[]) {
      const m = raw as { id?: unknown; label?: unknown; efforts?: unknown } | null;
      if (!m || typeof m !== "object" || typeof m.id !== "string" || m.id.trim() === "") {
        fail(`harness "${name}" \`models\` entries need a non-empty string \`id\``);
        continue;
      }
      if (seen.has(m.id)) fail(`harness "${name}" declares model "${m.id}" twice`);
      seen.add(m.id);
      if (m.label !== undefined && typeof m.label !== "string") {
        fail(`harness "${name}" model "${m.id}" \`label\` must be a string when present`);
      }
      if (m.efforts !== undefined && !isEffortList(m.efforts)) {
        fail(
          `harness "${name}" model "${m.id}" \`efforts\` must be a non-empty string[] when present`,
        );
      }
      models.push({
        id: m.id,
        ...(typeof m.label === "string" ? { label: m.label } : {}),
        ...(isEffortList(m.efforts) ? { efforts: m.efforts } : {}),
      });
    }
  }
  if (value.efforts !== undefined && !isEffortList(value.efforts)) {
    fail(`harness "${name}" \`efforts\` must be a non-empty string[] when present`);
  }
  const efforts = isEffortList(value.efforts) ? value.efforts : undefined;
  const defaultModel = value.defaultModel;
  if (defaultModel !== undefined) {
    if (typeof defaultModel !== "string" || defaultModel.trim() === "") {
      fail(`harness "${name}" \`defaultModel\` must be a non-empty string when present`);
    }
    if (!models?.some((m) => m.id === defaultModel)) {
      fail(`harness "${name}" defaultModel "${String(defaultModel)}" is not in its \`models\``);
    }
  }
  const defaultEffort = value.defaultEffort;
  if (defaultEffort !== undefined) {
    if (typeof defaultEffort !== "string" || defaultEffort.trim() === "") {
      fail(`harness "${name}" \`defaultEffort\` must be a non-empty string when present`);
    }
    // The ladder the default sits in: the default model's own efforts when it
    // declares them, else the harness-wide ladder - the same fallback the
    // selection adapter validates against at spawn time.
    const defaultModelEfforts = models?.find((m) => m.id === defaultModel)?.efforts;
    const ladder = defaultModelEfforts ?? efforts;
    if (!ladder) {
      fail(`harness "${name}" has a \`defaultEffort\` but declares no effort levels`);
    } else if (!ladder.includes(defaultEffort as string)) {
      fail(
        `harness "${name}" defaultEffort "${String(defaultEffort)}" is not in its effort levels (${ladder.join(", ")})`,
      );
    }
  }
  return {
    ...(models ? { models } : {}),
    ...(typeof defaultModel === "string" ? { defaultModel } : {}),
    ...(efforts ? { efforts } : {}),
    ...(typeof defaultEffort === "string" ? { defaultEffort } : {}),
  };
};

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
  // Prototype-free: a harness literally named `__proto__` or `constructor` must
  // be an ordinary key, not a mutation of (or a read through) Object.prototype.
  const harnesses: Record<string, SpawnRecipe> = Object.create(null);
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
    harnesses[name] = {
      spawn,
      ...(resume ? { resume } : {}),
      ...parseSelectionFields(name, value as Record<string, unknown>, path),
    };
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
/**
 * One harness, one identity, however it is spelled. A registry key of
 * `claude_code` and an artifact stamped `claude-code` are the same harness -
 * and treating them as different meant a recorded session could never be
 * resumed ("harness claude-code is not in the registry") on a machine whose
 * registry happened to use the other separator. Matches `canonicalHarness`.
 */
export const normalizeHarness = (name: string): string =>
  name.trim().toLowerCase().replace(/_/g, "-");

export const resolveRecipe = (
  registry: HarnessRegistry,
  harness?: string,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined => {
  // hasOwn, not truthiness: a registry object that still carries Object.prototype
  // would otherwise resolve "constructor" or "toString" as a harness.
  let name = harness !== undefined && Object.hasOwn(registry.harnesses, harness) ? harness : "";
  if (!name && harness !== undefined) {
    // Exact miss: try the same harness spelled the other way before falling
    // back to the default, which would resolve to a DIFFERENT agent.
    const wanted = normalizeHarness(harness);
    name = Object.keys(registry.harnesses).find((key) => normalizeHarness(key) === wanted) ?? "";
  }
  if (!name) name = registry.default ?? "";
  if (!name || !Object.hasOwn(registry.harnesses, name)) return undefined;
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
