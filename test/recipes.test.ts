import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_REGISTRY, loadRegistry, requireSessionIdentity } from "../src/launch/recipes.ts";

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
