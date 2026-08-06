import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXAMPLE_REGISTRY,
  harnessInfoOf,
  loadRegistry,
  requireSessionIdentity,
  type SpawnRecipe,
} from "../src/launch/recipes.ts";
import { effortLadderOf, multiTargets } from "../src/protocol/wire.ts";
import type { HarnessInfo } from "../src/protocol/wire.ts";

/**
 * M1.3 (ledger H4): the registry example the CLI error hands a user, and the
 * one in the README, are the SAME object, and it actually LOADS and passes the
 * identity requirements unattended launch enforces. The example used to be a
 * hand-typed copy in `run.ts` with no `sessionIdentity` - so copying it verbatim
 * produced a registry the launcher would then refuse as HSI001.
 */
describe("M1.3: EXAMPLE_REGISTRY loads and passes identity requirements", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-recipes-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the example parses and satisfies requireSessionIdentity", async () => {
    const path = join(dir, "harnesses.json");
    await writeFile(path, `${JSON.stringify(EXAMPLE_REGISTRY, null, 2)}\n`);
    const registry = await loadRegistry(path);
    expect(registry).not.toBeNull();
    const name = registry!.default!;
    const recipe = registry!.harnesses[name];
    expect(recipe).toBeDefined();
    // A user who copies the example verbatim must NOT then be refused by the
    // launcher's own identity gate (HSI001).
    const identity = requireSessionIdentity(name, recipe, path);
    expect(identity.source).toMatch(/caller-assigned|stdout-jsonl/);
  });

  test("the README's harness example is byte-identical to EXAMPLE_REGISTRY", async () => {
    // The palette.ts pin pattern: the docs example and the code constant are
    // one object, so a stale README cannot drift from the example that ships.
    const readme = await readFile("README.md", "utf8");
    const match = readme.match(/```json\n([\s\S]*?)```/)!;
    expect(match, "README has a json code block").not.toBeNull();
    const fromReadme = JSON.parse(match[1] as string);
    expect(fromReadme).toEqual(EXAMPLE_REGISTRY);
  });
});

describe("M2.1: effortLadderOf - the one ladder rule", () => {
  /**
   * The validator (launch) and the picker (chrome) each restated this rule;
   * one owner in `wire.ts` keeps a fork child the launcher drives and a pick a
   * human makes in the viewer from disagreeing about which efforts apply.
   */
  const vocab = (
    over: Partial<{
      models: readonly { id: string; efforts?: readonly string[] }[];
      defaultModel: string;
      efforts: readonly string[];
    }> = {},
  ): HarnessInfo => ({
    name: "stub",
    ...(over.models ? { models: over.models } : {}),
    ...(over.defaultModel ? { defaultModel: over.defaultModel } : {}),
    ...(over.efforts ? { efforts: over.efforts } : {}),
  });

  test("a model's own efforts outrank the harness-wide ladder", () => {
    const info = vocab({
      efforts: ["low", "high"],
      models: [{ id: "opus", efforts: ["low", "medium", "high"] }],
    });
    expect(effortLadderOf(info, "opus")).toEqual(["low", "medium", "high"]);
  });

  test("a model that declares no efforts falls back to the harness ladder", () => {
    const info = vocab({
      efforts: ["low", "high"],
      models: [{ id: "opus" }],
    });
    expect(effortLadderOf(info, "opus")).toEqual(["low", "high"]);
  });

  test("no model selected: the default model's ladder applies (preselection)", () => {
    const info = vocab({
      defaultModel: "sonnet",
      efforts: ["low", "high"],
      models: [
        { id: "sonnet", efforts: ["low", "medium"] },
        { id: "opus", efforts: ["high"] },
      ],
    });
    // No model passed: the registry's preselection (defaultModel) is the best
    // guess, not a promise about the CLI's own configured model. An empty
    // string is the picker's "nothing picked" row; undefined is the validator's.
    expect(effortLadderOf(info, undefined)).toEqual(["low", "medium"]);
    expect(effortLadderOf(info, "")).toEqual(["low", "medium"]);
    // A named-but-absent model falls through to the harness ladder, not the
    // default model's - it is a pick the registry no longer offers.
    expect(effortLadderOf(info, "gone")).toEqual(["low", "high"]);
  });

  test("undefined vocab or no ladder anywhere yields undefined", () => {
    expect(effortLadderOf(undefined, "x")).toBeUndefined();
    expect(effortLadderOf(vocab(), "x")).toBeUndefined();
  });
});

describe("M2.1: harnessInfoOf - the one projection", () => {
  /**
   * Both servers projected a SpawnRecipe to a HarnessInfo inline, with the
   * same five fields. `harnessInfoOf` owns it so a mounted host's picker and
   * the hub's identity picker cannot offer different vocabularies.
   */
  test("projects every HarnessInfo field", () => {
    const recipe: SpawnRecipe = {
      spawn: ["x"],
      models: [{ id: "opus", label: "Opus", efforts: ["high"] }],
      defaultModel: "opus",
      efforts: ["low", "high"],
      defaultEffort: "low",
      sessionIdentity: { argument: "--sid", source: "caller-assigned" },
    };
    const info = harnessInfoOf("claude_code", recipe);
    expect(info).toEqual({
      name: "claude_code",
      models: [{ id: "opus", label: "Opus", efforts: ["high"] }],
      defaultModel: "opus",
      efforts: ["low", "high"],
      defaultEffort: "low",
    });
  });

  test("omits absent optional fields (not undefined keys)", () => {
    const recipe: SpawnRecipe = { spawn: ["x"] };
    const info = harnessInfoOf("bare", recipe);
    expect(info).toEqual({ name: "bare" });
  });
});

describe("M2.2: multiTargets - the wire's one shape per arity (ledger 7)", () => {
  /**
   * `targets` is emitted only when two or more anchors share an annotation; a
   * singleton normalizes to the single `target`. Five sites restated this;
   * fold/payload used `> 0` (emitting a one-element list nothing consumes),
   * so the one owner is also the one that fixes the singleton wart.
   */
  test("a singleton omits targets (normalizes to the single target)", () => {
    expect(multiTargets(["only"])).toBeUndefined();
  });

  test("two or more preserves the list", () => {
    expect(multiTargets(["a", "b"])).toEqual(["a", "b"]);
    expect(multiTargets(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("empty or undefined yields undefined", () => {
    expect(multiTargets([])).toBeUndefined();
    expect(multiTargets(undefined)).toBeUndefined();
  });
});
