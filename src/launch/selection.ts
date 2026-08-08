import { harnessKind } from "../core/harness.ts";
import {
  type ArtifactSelection,
  type Selection,
  readSelection,
  sanitizeSelection,
  writeSelection,
} from "../core/selection-sidecar.ts";
import { effortLadderOf } from "../protocol/wire.ts";
import type { SpawnRecipe } from "./recipes.ts";

// Re-export the core-owned sidecar surface (M1.9): the types, validator, and
// reader/writer now live in `core/selection-sidecar.ts` so `core` never imports
// `launch`. Existing callers keep importing them from here unchanged.
export { readSelection, sanitizeSelection, writeSelection };
export type { ArtifactSelection, Selection };

/**
 * The model/effort selection adapter: how a human's pick in the viewer becomes
 * the harness CLI's own flags. Flag spellings are per-harness knowledge and
 * live ONLY here; every spawner (hub create, attend resume) goes through this
 * module, so a new harness's flags are added in one place.
 *
 * Discipline (skillval's): "default" means PASS NOTHING and let the CLI
 * decide - a synthesized value would pin behavior the human never chose. A
 * selection is validated against the registry's curated lists before it ever
 * reaches an argv, so a bad pick fails fast with a named error instead of a
 * dead agent turn.
 */

/** "default" = no explicit pick (skillval's discipline): emit nothing. */
const explicit = (value: string | undefined): string | undefined =>
  value === undefined || value === "default" || value.trim() === "" ? undefined : value;

/**
 * Compose the per-harness argv flags for a selection, validating it against
 * the recipe's curated lists. An empty selection is `[]` for ANY harness; a
 * non-empty one on a harness the adapter has no flags for is an error - a
 * silently dropped pick would run the wrong model without a trace.
 */
export const selectionArgs = (
  harnessName: string,
  recipe: SpawnRecipe,
  sel: Selection,
): string[] | { readonly error: string } => {
  const model = explicit(sel.model);
  const effort = explicit(sel.effort);
  if (model === undefined && effort === undefined) return [];
  const kind = harnessKind(harnessName);
  if (kind === undefined) {
    return { error: `no model/effort flags are known for harness "${harnessName}"` };
  }
  if (model !== undefined) {
    const ids = (recipe.models ?? []).map((m) => m.id);
    if (!ids.includes(model)) {
      return {
        error:
          ids.length === 0
            ? `harness "${harnessName}" declares no models, so model "${model}" cannot be validated`
            : `model "${model}" is not in harness "${harnessName}"'s models (${ids.join(", ")})`,
      };
    }
  }
  if (effort !== undefined) {
    // The ladder rule is owned by `effortLadderOf` (M2.1): the selected
    // model's own efforts, else the harness-wide ladder, with the default
    // model's ladder applying when none is selected. A pick the CLI's model
    // then refuses fails at the turn, in the CLI's own words.
    const ladder = effortLadderOf(recipe, model);
    if (!ladder) {
      return { error: `harness "${harnessName}" declares no effort levels` };
    }
    if (!ladder.includes(effort)) {
      // The scope is a display detail: which vocabulary the refused effort was
      // measured against. The ladder value itself came from the one owner.
      const modelId = model || recipe.defaultModel;
      const perModel = recipe.models?.find((m) => m.id === modelId)?.efforts;
      const scope = perModel ? `model "${modelId}"` : `harness "${harnessName}"`;
      return { error: `effort "${effort}" is not supported by ${scope} (${ladder.join(", ")})` };
    }
  }
  switch (kind) {
    case "claude":
      return [
        ...(model !== undefined ? ["--model", model] : []),
        ...(effort !== undefined ? ["--effort", effort] : []),
      ];
    case "codex":
      // -c values are parsed as TOML; a JSON-quoted string is a valid TOML string.
      return [
        ...(model !== undefined ? ["-c", `model=${JSON.stringify(model)}`] : []),
        ...(effort !== undefined ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ];
    case "pi":
      return [
        ...(model !== undefined ? ["--model", model] : []),
        ...(effort !== undefined ? ["--thinking", effort] : []),
      ];
    case "muse":
      return [
        ...(model !== undefined ? ["--model", model] : []),
        ...(effort !== undefined ? ["--reasoning-effort", effort] : []),
      ];
  }
};

/**
 * Insert composed selection args into a built recipe argv. Appending at the
 * end is WRONG for claude (the prompt is positional and `--allowedTools` is
 * variadic - trailing tokens get swallowed as tool names), so the rule is
 * positional: right after argv[0] for claude/pi, and for codex right after
 * its `exec` (or `exec resume`) subcommand tokens, where clap accepts `-c`
 * overrides for the subcommand.
 *
 * The index is read off the TEMPLATE, never the substituted argv: `{cwd}` or
 * `{prompt}` can hold the literal `exec`, and a flag placed against a
 * substituted value is a silent misfire. `buildArgv` maps one template token to
 * one argv token, so the two index identically.
 */
export const insertSelectionArgs = (
  harnessName: string,
  argv: readonly string[],
  args: readonly string[],
  template: readonly string[] = argv,
): string[] => {
  if (args.length === 0) return [...argv];
  let at = 1;
  const kind = harnessKind(harnessName);
  if (kind === "codex" || kind === "muse") {
    // Last, not first: a recipe fronted by a wrapper (`direnv exec . codex
    // exec ...`) has the wrapper's own `exec` ahead of the harness's.
    // Muse is the same: `muse exec` is the subcommand that owns --model
    // and --reasoning-effort, while `muse resume` (interactive) takes none.
    const exec = template.lastIndexOf("exec");
    if (exec !== -1) {
      at = exec + 1;
      if (template[at] === "resume") at += 1;
    }
  }
  return [...argv.slice(0, at), ...args, ...argv.slice(at)];
};

/** Validate a selection and weave its flags into a built argv, in one step -
 *  the shape every spawner consumes. */
export const applySelection = (
  harnessName: string,
  recipe: SpawnRecipe,
  argv: readonly string[],
  sel: Selection,
  template: readonly string[] = argv,
): string[] | { readonly error: string } => {
  const args = selectionArgs(harnessName, recipe, sel);
  if ("error" in args) return args;
  return insertSelectionArgs(harnessName, argv, args, template);
};
