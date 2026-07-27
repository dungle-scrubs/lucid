import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { on } from "./e2e/locators.ts";

const REPO = join(import.meta.dirname, "..");

/**
 * `locators.ts` is generated, and nothing regenerates it.
 *
 * That is the failure this file exists for, and it had already happened once
 * before anybody looked: regenerating deleted the `orphan()` factory the
 * hand-written version had, because the generator's pattern saw only the second
 * branch of `data-test={orphaned ? "orphan" : "annotation"}`. The change that
 * introduced generation - and claimed it made falling behind impossible - was
 * the change that fell behind.
 *
 * A grep, not a browser: it compares two lists of strings and runs in the unit
 * suite, so a product hook added without a factory is red in ten seconds.
 */

/** Every `data-test` name the product can render. */
const productHooks = async (): Promise<Set<string>> => {
  const entries = (await readdir(join(REPO, "client"), { withFileTypes: true, recursive: true }))
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  const names = new Set<string>();
  for (const path of entries) {
    const text = await readFile(path, "utf8");
    // A conditional hook carries more than one name.
    for (const m of text.matchAll(/data-test=\{([^}]*)\}/g)) {
      for (const lit of m[1]?.matchAll(/"([a-z0-9-]+)"/g) ?? []) names.add(lit[1] as string);
    }
    for (const m of text.matchAll(/data-test="([a-z0-9-]+)"/g)) names.add(m[1] as string);
    // Passed as a prop and applied to `data-test={…}` at the other end, so the
    // literal never appears next to the attribute.
    for (const m of text.matchAll(/\btestId="([a-z0-9-]+)"/g)) names.add(m[1] as string);
    for (const m of text.matchAll(/\btest="([a-z0-9-]+)"/g)) names.add(m[1] as string);
  }
  return names;
};

/** camelCase, the way the generator names a factory. */
const factoryName = (hook: string): string => {
  const [head, ...rest] = hook.split("-");
  return (head ?? "") + rest.map((p) => p[0]?.toUpperCase() + p.slice(1)).join("");
};

describe("locators.ts against the product", () => {
  test("every hook the product renders has a factory", async () => {
    const factories = new Set(Object.keys(on({} as never)));
    const missing = [...(await productHooks())]
      .filter((h) => !factories.has(factoryName(h)))
      // Composed at render time (`${test}-heading`), so the literal is a
      // fragment rather than a hook anyone can select by.
      .filter((h) => !h.endsWith("-heading"));

    expect(
      missing.sort(),
      `hooks with no factory - regenerate locators.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("no factory outlives the hook it names", async () => {
    // The other direction. A factory for a hook nobody renders is a selector
    // that silently matches nothing, and a test using it asserts absence
    // forever without saying so.
    const hooks = await productHooks();
    const named = new Set([...hooks].map(factoryName));
    const orphaned = Object.keys(on({} as never)).filter((f) => !named.has(f));

    expect(
      orphaned.sort(),
      `factories whose hook is gone from client/: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });
});
