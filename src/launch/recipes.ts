import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasControlCharacters } from "../core/events.ts";
import { harnessKind, normalizeHarness } from "../core/harness.ts";
import { IdentityDeclarationError, ValidationError } from "../errors.ts";
import type { HarnessInfo } from "../protocol/wire.ts";
import { effortLadderOf } from "../protocol/wire.ts";
import type { SessionIdentityRecipe } from "./session-identity.ts";

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
export type RecipeVar = "id" | "seed" | "artifact" | "cwd" | "prompt" | "tools";

const RECIPE_VARS: readonly RecipeVar[] = ["id", "seed", "artifact", "cwd", "prompt", "tools"];

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
   * What a headless turn is allowed to do, as an editable list rather than a
   * string buried in `spawn`.
   *
   * This is the security posture of every unattended turn, so it deserves to
   * be a property someone can read and change without re-deriving an argv:
   * write `{tools}` where the harness takes its allowlist and the entries land
   * there, space-joined, in order. Which flag that is stays the recipe's
   * business - `--allowedTools` for claude-code, something else elsewhere -
   * because the whole point of the registry is that Lucid compiles no launch
   * command of its own.
   *
   * Shared by `spawn` and `resume` deliberately: a turn that may write the
   * artifact on creation and not on revision is a grant nobody meant to make.
   * A mode that genuinely needs a different list spells it literally in its
   * own argv and omits the placeholder.
   */
  readonly tools?: readonly string[];
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
  /** Harness-wide effort ladder, the fallback `effortLadderOf` uses when a
   *  model declares no `efforts` of its own (pi normalizes one ladder across
   *  every model). */
  readonly efforts?: readonly string[];
  /** The effort preselected in pickers; must be in the ladder that applies
   *  (the default model's `efforts`, else the harness-wide `efforts`). */
  readonly defaultEffort?: string;
  /**
   * How this harness's native session identity is established - assigned by
   * Lucid through an argv flag, or discovered from structured stdout. Optional
   * at the JSON boundary so an old registry still LOADS (its recipes remain
   * inspectable), but unattended launch refuses an absent declaration as
   * HSI001: a session that cannot be identified cannot be resumed, and finding
   * that out after the turn ran is the bug this field exists to prevent.
   */
  readonly sessionIdentity?: SessionIdentityRecipe;
}

/**
 * The ONE projection of a recipe to the wire `HarnessInfo` a picker renders
 * (M2.1). Both servers used to build this inline with the same five fields; a
 * mounted host's `/selection` and the hub's `/identity` cannot offer different
 * vocabularies, so the projection is owned beside the recipe it reads.
 */
export const harnessInfoOf = (name: string, recipe: SpawnRecipe): HarnessInfo => ({
  name,
  ...(recipe.models ? { models: recipe.models } : {}),
  ...(recipe.defaultModel !== undefined ? { defaultModel: recipe.defaultModel } : {}),
  ...(recipe.efforts ? { efforts: recipe.efforts } : {}),
  ...(recipe.defaultEffort !== undefined ? { defaultEffort: recipe.defaultEffort } : {}),
});

export interface HarnessRegistry {
  /** Recipe to use when the parent session's harness is unknown/unlisted. */
  readonly default?: string;
  readonly harnesses: Readonly<Record<string, SpawnRecipe>>;
}

/**
 * The one registry example the docs and the CLI error both show (M1.3, ledger
 * H4). It is a complete, valid registry - it LOADS through `parseRegistry` and
 * satisfies `requireSessionIdentity` - so a user who copies it verbatim is not
 * then refused by the launcher's own identity gate (HSI001). The README json
 * block is pinned to this object by test, so the docs cannot drift from it.
 */
export const EXAMPLE_REGISTRY: HarnessRegistry = {
  default: "claude_code",
  harnesses: {
    claude_code: {
      spawn: ["claude", "-p", "--session-id", "{id}", "{prompt}"],
      resume: ["claude", "--resume", "{id}", "-p", "{prompt}"],
      models: [{ id: "opus", label: "Opus 5" }],
      defaultModel: "opus",
      efforts: ["low", "medium", "high"],
      sessionIdentity: {
        argument: "--session-id",
        source: "caller-assigned",
        resumeArgument: "--resume",
      },
    },
  },
};

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
  // a fixed set of harness families (`core/harness.ts` owns the test), and a
  // declaration on any other one can only ever render a picker whose every pick
  // is refused at spawn.
  if (
    harnessKind(name) === undefined &&
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
    // The ladder the default sits in, through the one owner (M2.1) rather than
    // a restatement: the default model's own efforts, else the harness-wide
    // ladder - the same rule the selection adapter validates against at spawn.
    const ladder = effortLadderOf(
      {
        ...(models ? { models } : {}),
        ...(typeof defaultModel === "string" ? { defaultModel } : {}),
        ...(efforts ? { efforts } : {}),
      },
      undefined,
    );
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

/** A declaration selector: what identity validation will match against argv
 *  tokens or JSONL records. Bounded so a registry typo (or a hostile file)
 *  cannot smuggle control characters into matching or grow without limit. */
const SELECTOR_MAX = 128;
const isBoundedSelector = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= SELECTOR_MAX && !hasControlCharacters(v);

/**
 * Validate a PRESENT `sessionIdentity` declaration against the recipe's own
 * argv templates. The declaration and the argv are one protocol - an identity
 * flag the spawn never passes, or a resume with nowhere to put the id, is a
 * recipe that will launch sessions it can never find again (HSI001, while the
 * file is on screen).
 *
 * Caller-assigned: the identity argument must be immediately followed by
 * `{id}` in spawn AND resume - adjacency, not mere presence, because
 * `--session-id` binding to the wrong token is exactly how an id ends up in a
 * prompt.
 * Discovered (stdout-jsonl): spawn and resume must carry the structured-output
 * argument (or discovery is blind), and resume must carry an exact `{id}`
 * token for the discovered id to re-enter.
 */
const parseSessionIdentity = (
  name: string,
  value: Record<string, unknown>,
  spawn: readonly string[],
  resume: readonly string[] | undefined,
  path: string,
): SessionIdentityRecipe | undefined => {
  const decl = value.sessionIdentity;
  if (decl === undefined) return undefined;
  // Annotated on the const, where TS recognizes never-return and narrows
  // after each call - which is what lets the checks below stand without casts.
  const fail: (message: string) => never = (message) => {
    throw new IdentityDeclarationError({ message, detail: { path, harness: name } });
  };
  if (typeof decl !== "object" || decl === null) {
    fail(`harness "${name}" \`sessionIdentity\` must be an object when present`);
  }
  const d = decl as Record<string, unknown>;
  const adjacentIdAfter = (argv: readonly string[], argument: string): boolean =>
    argv.some((tok, i) => tok === argument && argv[i + 1] === "{id}");

  if (d.source === "caller-assigned") {
    if (!isBoundedSelector(d.argument)) {
      fail(`harness "${name}" caller-assigned identity needs a bounded \`argument\` flag`);
    }
    const argument = d.argument;
    if (d.resumeArgument !== undefined && !isBoundedSelector(d.resumeArgument)) {
      fail(`harness "${name}" \`resumeArgument\` must be a bounded flag when present`);
    }
    // The resume flag may differ from the assign flag: claude assigns with
    // `--session-id <id>` and re-enters with `--resume <id>`, and demanding
    // one spelling for both would refuse a correct recipe.
    const resumeArgument = isBoundedSelector(d.resumeArgument) ? d.resumeArgument : argument;
    if (!adjacentIdAfter(spawn, argument)) {
      fail(`harness "${name}" spawn argv must pass "${argument}" immediately followed by "{id}"`);
    }
    if (resume && !adjacentIdAfter(resume, resumeArgument)) {
      fail(
        `harness "${name}" resume argv must pass "${resumeArgument}" immediately followed by "{id}"`,
      );
    }
    return {
      argument,
      ...(resumeArgument !== argument ? { resumeArgument } : {}),
      source: "caller-assigned",
    };
  }

  if (d.source === "stdout-jsonl") {
    if (!isBoundedSelector(d.event)) {
      fail(`harness "${name}" stdout-jsonl identity needs a bounded \`event\``);
    }
    if (!isBoundedSelector(d.field)) {
      fail(`harness "${name}" stdout-jsonl identity needs a bounded \`field\``);
    }
    if (!isBoundedSelector(d.requiredArgument)) {
      fail(`harness "${name}" stdout-jsonl identity needs a bounded \`requiredArgument\``);
    }
    if (d.allowRotation !== undefined && typeof d.allowRotation !== "boolean") {
      fail(`harness "${name}" \`allowRotation\` must be a boolean when present`);
    }
    const requiredArgument = d.requiredArgument;
    if (!spawn.includes(requiredArgument)) {
      fail(`harness "${name}" spawn argv must pass "${requiredArgument}" for identity discovery`);
    }
    if (resume) {
      if (!resume.includes(requiredArgument)) {
        fail(
          `harness "${name}" resume argv must pass "${requiredArgument}" for identity discovery`,
        );
      }
      if (!resume.includes("{id}")) {
        fail(`harness "${name}" resume argv must carry an exact "{id}" token to resume`);
      }
    }
    return {
      allowRotation: d.allowRotation === true,
      event: d.event,
      field: d.field,
      requiredArgument,
      source: "stdout-jsonl",
    };
  }

  return fail(
    `harness "${name}" \`sessionIdentity.source\` must be "caller-assigned" or "stdout-jsonl"`,
  );
};

/**
 * The identity strategy unattended launch requires, or HSI001. Loading keeps
 * legacy identity-free recipes visible for diagnosis (see the `sessionIdentity`
 * field doc for why the split); SPAWNING one unattended is refused here,
 * before any process exists.
 */
export const requireSessionIdentity = (
  harness: string,
  recipe: SpawnRecipe | undefined,
  path: string,
): SessionIdentityRecipe => {
  const declared = recipe?.sessionIdentity;
  if (declared) return declared;
  throw new IdentityDeclarationError({
    message: `harness "${harness}" declares no session identity strategy; unattended launch would create a session Lucid cannot resume`,
    detail: { path, harness },
  });
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
    const tools = (value as { tools?: unknown })?.tools;
    if (
      tools !== undefined &&
      (!isStringArray(tools) || tools.length === 0 || tools.some((x) => x.trim() === ""))
    ) {
      throw new ValidationError({
        message: `harness "${name}" \`tools\` must be a non-empty string[] of tool grants when present`,
        detail: { path, harness: name },
      });
    }
    // A `{tools}` with nothing behind it would substitute empty, which for
    // claude-code means `--allowedTools ""` - a turn granted nothing, failing
    // on its first tool call with no hint as to why. Refused at load, where
    // the file being edited is still on screen.
    const wantsTools = [...spawn, ...(isStringArray(resume) ? resume : [])].some((tok) =>
      tok.includes("{tools}"),
    );
    if (wantsTools && !isStringArray(tools)) {
      throw new ValidationError({
        message: `harness "${name}" uses {tools} in its argv but declares no \`tools\` list`,
        detail: { path, harness: name },
      });
    }
    const sessionIdentity = parseSessionIdentity(
      name,
      value as Record<string, unknown>,
      spawn,
      isStringArray(resume) ? resume : undefined,
      path,
    );
    harnesses[name] = {
      spawn,
      ...(resume ? { resume } : {}),
      ...(isStringArray(tools) ? { tools } : {}),
      ...parseSelectionFields(name, value as Record<string, unknown>, path),
      ...(sessionIdentity ? { sessionIdentity } : {}),
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

/**
 * Recover the session identity a harness minted during spawn. Most recipes
 * accept Lucid's `{id}` directly. Codex mints its own thread id, exposed by
 * `codex exec --json` as a `thread.started` event, so a later resume can name
 * the exact thread instead of racing on `--last`.
 *
 * @deprecated Whole-output scan with the Codex selectors compiled in. The
 * registry now DECLARES those selectors and `SessionIdentityDecoder` reads
 * them streaming and bounded; the spawn-integration milestone (M3) moves the
 * one caller (`attend.ts`) onto typed spawn results and deletes this.
 */
export const spawnedSessionId = (harness: string, output: string): string | undefined => {
  if (normalizeHarness(harness) !== "codex") return undefined;
  for (const line of output.split("\n")) {
    if (!line.includes("thread.started")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // A harness log may mix narration with JSON events. Non-JSON lines are
      // evidence for humans, not a reason to discard a later structured id.
    }
  }
  return undefined;
};

/** The registry's own key for a harness, spelled either way: `claude-code` on
 *  an artifact IS a registry keyed `claude_code`. Undefined when the registry
 *  does not list that harness at all. */
const registryKey = (registry: HarnessRegistry, harness: string): string | undefined => {
  // hasOwn, not truthiness: a registry object that still carries Object.prototype
  // would otherwise resolve "constructor" or "toString" as a harness.
  if (Object.hasOwn(registry.harnesses, harness)) return harness;
  const wanted = normalizeHarness(harness);
  return Object.keys(registry.harnesses).find((key) => normalizeHarness(key) === wanted);
};

const recipeAt = (
  registry: HarnessRegistry,
  name: string,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined => {
  if (!name || !Object.hasOwn(registry.harnesses, name)) return undefined;
  const recipe = registry.harnesses[name];
  return recipe ? { name, recipe } : undefined;
};

/**
 * The recipe for the harness a caller NAMED, and never another one: a harness
 * the registry does not list resolves to undefined rather than to the default,
 * which is a DIFFERENT agent.
 *
 * This is the question almost every caller has. Spawning or resuming under the
 * default when harness X was asked for appends to the wrong harness's
 * transcript. The harness is required rather than optional on purpose: a caller
 * holding no harness at all is asking a different question, and answers it with
 * `defaultRecipe`, so the default can never become what an unlisted harness
 * quietly decays into.
 */
export const resolveExactRecipe = (
  registry: HarnessRegistry,
  harness: string,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined =>
  recipeAt(registry, registryKey(registry, harness) ?? "");

/** The registry's own default recipe: the answer when there is no harness to
 *  name - a create request that named none, an artifact no agent has stamped
 *  yet. Naming one and getting this instead is what `resolveExactRecipe`
 *  exists to prevent, so it has to be asked for. */
export const defaultRecipe = (
  registry: HarnessRegistry,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined =>
  recipeAt(registry, registry.default ?? "");

/**
 * The recipe for a harness: the named one if listed, else the registry default.
 * Returns the resolved name alongside so callers can log which ran.
 *
 * Only the fork launcher wants this. A fork starts a NEW child session from a
 * text seed, so an unlisted harness landing on the default costs a different
 * agent, never a corrupted transcript - and the launcher writes its manual
 * command (D-064) only when the registry answers nothing at all, default
 * included. Every other caller must not silently get a different agent, and
 * wants `resolveExactRecipe`.
 */
export const resolveRecipe = (
  registry: HarnessRegistry,
  harness?: string,
): { readonly name: string; readonly recipe: SpawnRecipe } | undefined =>
  recipeAt(
    registry,
    (harness !== undefined ? registryKey(registry, harness) : undefined) ?? registry.default ?? "",
  );

/** Substitute `{var}` placeholders in an argv template (a recipe's `spawn` or
 *  `resume`). Unknown `{tokens}` are left verbatim; a declared var with no value
 *  substitutes empty. */
export const buildArgv = (
  template: readonly string[],
  subs: Readonly<Partial<Record<RecipeVar, string>>>,
  /** The recipe's own `tools`, filling `{tools}`. Separate from `subs` because
   *  it comes from the recipe rather than from the fork, and because passing
   *  it is what the check below can then insist on. */
  tools?: readonly string[],
): string[] => {
  const grant = tools?.join(" ") ?? "";
  // An empty grant substituted into `--allowedTools {tools}` is a turn allowed
  // nothing, which fails on its first tool call with nothing to read. The
  // registry refuses that combination at load; this is the same refusal at the
  // one point a caller could reintroduce it by forgetting to pass the list.
  if (grant === "" && template.some((tok) => tok.includes("{tools}"))) {
    throw new ValidationError({
      message: "recipe argv uses {tools} but no tool grants were supplied",
      detail: { argv: template.join(" ") },
    });
  }
  return template.map((tok) =>
    tok.replace(/\{([a-z]+)\}/g, (whole, key: string) =>
      key === "tools"
        ? grant
        : RECIPE_VARS.includes(key as RecipeVar)
          ? (subs[key as RecipeVar] ?? "")
          : whole,
    ),
  );
};
