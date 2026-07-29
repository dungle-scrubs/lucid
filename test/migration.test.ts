import { describe, expect, test } from "bun:test";
import {
  invertOp,
  planContainerGitignore,
  planRecordMigration,
  rewriteForkSeedPaths,
  type MigrationOp,
  type RecordToMigrate,
} from "../src/core/migration.ts";

/**
 * The migration planner, as data (plan 02, MB.4).
 *
 * The whole point of planning it as a list of reversible ops is that the
 * dangerous half - moving a human's review history - is decided by a pure
 * function a test can pin exactly, and executed by a mechanical replay that
 * inverts to a byte-identical tree.
 */

const record = (over: Partial<RecordToMigrate>): RecordToMigrate => ({
  recordDir: "/p/.lucid/plan",
  artifact: "/p/.lucid/plan.html",
  layout: "canonical",
  entries: ["log.ndjson", "versions"],
  gitignore: "run/\n",
  ...over,
});

const renames = (ops: readonly MigrationOp[]) =>
  ops.filter((o): o is Extract<MigrationOp, { kind: "rename" }> => o.kind === "rename");

describe("planRecordMigration", () => {
  test("a canonical record already in place is a no-op", () => {
    expect(planRecordMigration(record({})).ops).toEqual([]);
  });

  test("an orphaned record is skipped, never touched (D-011)", () => {
    const plan = planRecordMigration(record({ layout: "unknown", artifact: null }));
    expect(plan.ops).toEqual([]);
    expect(plan.skip).toContain("orphaned");
  });

  test("nested: the ARTIFACT moves into .lucid, the record stays", () => {
    // record at <D>/.lucid/plan, artifact OUTSIDE at <D>/plan.html.
    const plan = planRecordMigration(
      record({ recordDir: "/D/.lucid/plan", artifact: "/D/plan.html", layout: "nested" }),
    );
    const mv = renames(plan.ops);
    expect(mv).toContainEqual({ kind: "rename", from: "/D/plan.html", to: "/D/.lucid/plan.html" });
    // the record dir is NOT renamed - it is already under .lucid/.
    expect(mv.some((o) => o.from === "/D/.lucid/plan")).toBe(false);
  });

  test("sibling: BOTH artifact and record move into a new .lucid", () => {
    const plan = planRecordMigration(
      record({ recordDir: "/D/plan", artifact: "/D/plan.html", layout: "sibling" }),
    );
    const mv = renames(plan.ops);
    expect(mv).toContainEqual({ kind: "rename", from: "/D/plan.html", to: "/D/.lucid/plan.html" });
    expect(mv).toContainEqual({ kind: "rename", from: "/D/plan", to: "/D/.lucid/plan" });
  });

  test("machine-local entries relocate under run/; content stays", () => {
    const plan = planRecordMigration(
      record({
        recordDir: "/D/plan",
        artifact: "/D/plan.html",
        layout: "sibling",
        entries: [
          "log.ndjson",
          "versions",
          "pasted",
          "server.json",
          "current.html",
          "context.json",
        ],
      }),
    );
    const mv = renames(plan.ops);
    // server.json / current.html / context.json go to run/ (under the FINAL dir).
    expect(mv).toContainEqual({
      kind: "rename",
      from: "/D/.lucid/plan/server.json",
      to: "/D/.lucid/plan/run/server.json",
    });
    // log.ndjson / versions / pasted are committed history - never relocated.
    expect(mv.some((o) => o.from.endsWith("/log.ndjson"))).toBe(false);
    expect(mv.some((o) => o.from.endsWith("/versions"))).toBe(false);
    expect(mv.some((o) => o.from.endsWith("/pasted"))).toBe(false);
  });

  test("a bare-* .gitignore is rewritten to run/, recording its prior bytes", () => {
    const plan = planRecordMigration(record({ gitignore: "*\n" }));
    expect(plan.ops).toContainEqual({
      kind: "write",
      path: "/p/.lucid/plan/.gitignore",
      content: "run/\n",
      priorContent: "*\n",
    });
  });

  test("an already-run/ .gitignore is left alone", () => {
    expect(planRecordMigration(record({ gitignore: "run/\n" })).ops).toEqual([]);
  });
});

describe("planContainerGitignore: the container-level R1 trap", () => {
  test("a bare-* .lucid/.gitignore is deleted, prior bytes recorded", () => {
    expect(planContainerGitignore("/D/.lucid/.gitignore", "*\n")).toEqual([
      { kind: "delete", path: "/D/.lucid/.gitignore", priorContent: "*\n" },
    ]);
  });

  test("an absent container .gitignore yields no op", () => {
    expect(planContainerGitignore("/D/.lucid/.gitignore", null)).toEqual([]);
  });

  test("a deliberate (non-bare) container .gitignore is left alone", () => {
    expect(planContainerGitignore("/D/.lucid/.gitignore", "run/\nnode_modules\n")).toEqual([]);
  });
});

describe("invertOp: every op reverses to its exact prior state", () => {
  test("rename swaps ends", () => {
    expect(invertOp({ kind: "rename", from: "a", to: "b" })).toEqual({
      kind: "rename",
      from: "b",
      to: "a",
    });
  });

  test("a write over an existing file restores the old bytes", () => {
    expect(invertOp({ kind: "write", path: "g", content: "run/\n", priorContent: "*\n" })).toEqual({
      kind: "write",
      path: "g",
      content: "*\n",
      priorContent: "run/\n",
    });
  });

  test("a write that CREATED a file inverts to deleting it", () => {
    expect(invertOp({ kind: "write", path: "g", content: "run/\n", priorContent: null })).toEqual({
      kind: "delete",
      path: "g",
      priorContent: "run/\n",
    });
  });
});

describe("rewriteForkSeedPaths (D-013)", () => {
  test("absolute paths become record-relative so the seed travels", () => {
    const seed = "parent: /D/plan.html\nimage: /D/plan/pasted/a1.png";
    const out = rewriteForkSeedPaths(seed, [
      ["/D/plan/pasted", "pasted"],
      ["/D/plan.html", "../plan.html"],
    ]);
    expect(out).toBe("parent: ../plan.html\nimage: pasted/a1.png");
  });

  test("longest prefix wins - the artifact pair does not mangle the pasted pair", () => {
    // /D/plan is a prefix of /D/plan/pasted; the specific pasted pair must apply
    // first or the general one would corrupt the pasted path.
    const out = rewriteForkSeedPaths("/D/plan/pasted/x", [
      ["/D/plan", "."],
      ["/D/plan/pasted", "pasted"],
    ]);
    expect(out).toBe("pasted/x");
  });
});
