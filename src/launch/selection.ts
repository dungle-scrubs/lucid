import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionPaths } from "../core/paths.ts";
import type { SpawnRecipe } from "./recipes.ts";

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

/** A human's model/effort pick. Absent (or "default") fields emit nothing. */
export interface Selection {
  readonly model?: string;
  readonly effort?: string;
}

/** The per-artifact sticky selection (`.lucid/<name>/selection.json`): the
 *  model/effort every later unattended turn reuses. `harness` records which
 *  vocabulary the pick was made in, so a resume under a different harness is
 *  detectable rather than silently misapplied. */
export interface ArtifactSelection extends Selection {
  readonly harness?: string;
}

/** Registry harness names the adapter knows flags for, normalized. */
type KnownHarness = "claude-code" | "codex" | "pi";

/** Normalize a registry harness name for flag lookup: the docs' example spells
 *  it `claude_code`, the seeded registry `claude-code` - one harness. Exported
 *  so the registry parser can refuse a model/effort declaration on a harness
 *  this adapter has no flags for. */
export const canonicalHarness = (name: string): KnownHarness | undefined => {
  const n = name.toLowerCase().replace(/_/g, "-");
  return n === "claude-code" || n === "codex" || n === "pi" ? n : undefined;
};

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
  const kind = canonicalHarness(harnessName);
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
    // The ladder that applies: the selected model's own efforts, else the
    // harness-wide ladder. With no model selected the default model's ladder
    // applies - that is the registry's PRESELECTION, not a promise about the
    // CLI, which resolves its own configured model when none is passed. A pick
    // the CLI's model then refuses fails at the turn, in the CLI's own words.
    const modelId = model ?? recipe.defaultModel;
    const perModel = recipe.models?.find((m) => m.id === modelId)?.efforts;
    const ladder = perModel ?? recipe.efforts;
    if (!ladder) {
      return { error: `harness "${harnessName}" declares no effort levels` };
    }
    if (!ladder.includes(effort)) {
      const scope = perModel ? `model "${modelId}"` : `harness "${harnessName}"`;
      return { error: `effort "${effort}" is not supported by ${scope} (${ladder.join(", ")})` };
    }
  }
  switch (kind) {
    case "claude-code":
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
  if (canonicalHarness(harnessName) === "codex") {
    // Last, not first: a recipe fronted by a wrapper (`direnv exec . codex
    // exec ...`) has the wrapper's own `exec` ahead of the harness's.
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

/** Bound + clean one selection field: a string with control chars stripped,
 *  trimmed, non-empty and not "default" (which means "no explicit pick"). */
const cleanField = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c > 0x1f && c !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 && cleaned !== "default" ? cleaned : undefined;
};

/** The ONE selection normalizer, shared by every reader and writer (route
 *  bodies, the sidecar file), so a malformed field is dropped - bounded,
 *  control-free - no matter which surface it arrived through. Returns
 *  undefined when nothing usable remains. */
export const sanitizeSelection = (input: unknown): ArtifactSelection | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const harness = cleanField(o.harness, 64);
  const model = cleanField(o.model, 128);
  const effort = cleanField(o.effort, 32);
  if (!harness && !model && !effort) return undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
};

/** `.lucid/<name>/selection.json` - the sticky per-artifact selection. */
export const selectionPath = (paths: SessionPaths): string => paths.selectionPath;

/** Read the artifact's sticky selection. Absent or unreadable = none: the
 *  sidecar is advisory, and a corrupt one must not stall delivery. */
export const readSelection = async (
  paths: SessionPaths,
): Promise<ArtifactSelection | undefined> => {
  try {
    return sanitizeSelection(JSON.parse(await readFile(selectionPath(paths), "utf8")));
  } catch {
    return undefined;
  }
};

/** Persist the artifact's sticky selection (whole-file overwrite; last write
 *  wins, like the other advisory sidecars). Normalized on the way OUT as well
 *  as in, so what is stored is exactly what `readSelection` gives back - an
 *  over-long harness name or model id that only got bounded on read would no
 *  longer match its own registry entry, and every later resume would reject
 *  the pick it just accepted. */
export const writeSelection = async (
  paths: SessionPaths,
  selection: ArtifactSelection,
): Promise<void> => {
  const clean = sanitizeSelection(selection) ?? {};
  // selection.json lives in run/ (plan 02); ensure it exists so a write
  // before the record is fully set up cannot fail on a missing parent.
  const target = selectionPath(paths);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(clean, null, 2)}\n`);
};
