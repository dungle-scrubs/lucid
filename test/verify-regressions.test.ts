import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REGRESSIONS } from "./e2e/regression/registry.ts";
import { applyEdit, planFor } from "../scripts/verify-regressions.ts";

const REPO = join(import.meta.dirname, "..");

/**
 * The verifier's own tests.
 *
 * `verify-regressions.ts` is the thing that decides whether the regression
 * suite is real, so the ways it can lie quietly are what these cover: a
 * mutation that silently matches nothing, a row it skips without saying so,
 * and a registry entry that has drifted from the test it names.
 */

describe("planFor", () => {
  test("every row is accounted for - tested, or reported as unprovable", () => {
    // The failure this prevents: a verifier that iterates only the rows with
    // tests, reports all green, and never mentions the four it could not check.
    const plan = planFor(REGRESSIONS);
    expect(plan.checks.length + plan.unprovable.length).toBe(REGRESSIONS.length);
    expect(plan.unprovable.length).toBeGreaterThan(0);
    for (const row of plan.unprovable) expect(row.why.length).toBeGreaterThan(40);
  });

  test("a row with a test must carry a mutation, and one without must not", () => {
    const plan = planFor([
      {
        sha: "aaaaaaa",
        broke: "x",
        testFile: "test/e2e/regression/x.e2e.ts",
        testName: "x",
        mutation: { kind: "none", why: "a".repeat(50) },
      },
    ]);
    expect(plan.contradictions).toEqual([
      "aaaaaaa names a test but declares no mutation that could make it fail",
    ]);
  });
});

describe("applyEdit", () => {
  test("replaces the one occurrence it was given", () => {
    expect(applyEdit("a\nkeep me\nb\n", { find: "keep me", replace: "gone" })).toBe("a\ngone\nb\n");
  });

  test("refuses a find string that matches nothing", () => {
    // The quiet failure: the edit does not apply, the test still passes, and
    // the verifier reports the row as proven.
    expect(() => applyEdit("a\nb\n", { find: "not here", replace: "x" })).toThrow(
      /matched 0 times/,
    );
  });

  test("refuses a find string that matches more than once", () => {
    // Ambiguity is the same defect wearing a different hat: it would mutate
    // more than the row claims, and the red would not mean what it says.
    expect(() => applyEdit("x\nx\n", { find: "x", replace: "y" })).toThrow(/matched 2 times/);
  });
});

describe("the registry describes this repository", () => {
  test("every named test file exists and declares the named test", async () => {
    const missing: string[] = [];
    for (const row of REGRESSIONS) {
      if (!row.testFile || !row.testName) continue;
      const source = await readFile(join(REPO, row.testFile), "utf8").catch(() => "");
      if (!source.includes(row.testName)) missing.push(`${row.sha}: ${row.testName}`);
    }
    expect(missing).toEqual([]);
  });

  test("every edit mutation still matches its file exactly once", async () => {
    // A mutation that has rotted is a row that stopped being verifiable, and
    // nothing else in the repo would say so until someone ran the verifier.
    const rotten: string[] = [];
    for (const row of REGRESSIONS) {
      if (row.mutation.kind !== "edit") continue;
      const source = await readFile(join(REPO, row.mutation.file), "utf8").catch(() => "");
      const hits = source.split(row.mutation.find).length - 1;
      if (hits !== 1) rotten.push(`${row.sha}: ${row.mutation.file} matched ${hits} times`);
    }
    expect(rotten).toEqual([]);
  });
});
