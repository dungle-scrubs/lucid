import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type CatalogueRow,
  checkLedger,
  GRANDFATHERED_WITHOUT_MUTATION,
  mutationDebt,
  summarise,
  testDeclarationsIn,
  testTitlesIn,
  unmutatedNewcomers,
} from "../scripts/coverage-check.ts";

const REPO = join(import.meta.dirname, "..");

/** A Playwright JSON report with the given tests in one file, shaped the way
 *  the reporter really emits it: `file` relative to `testDir`, one spec per
 *  test, and the outcome on the spec's `tests[].status`. */
const report = (file: string, tests: ReadonlyArray<[string, string]>) => ({
  suites: [
    {
      title: file,
      file,
      specs: tests.map(([title, status]) => ({
        title,
        ok: status === "expected",
        tests: [{ status }],
      })),
    },
  ],
});

/**
 * The catalogue stops being prose and starts being checkable.
 *
 * The hand-written `coverageSummary` in the file said `257 total, 35 covered`
 * while the rows said 256 and 39, and the progress report said something else
 * again. Three numbers, one of them written down at a moment that has passed.
 * A total nobody maintains is the failure this milestone exists to remove.
 */
describe("summarise", () => {
  test("counts what the rows say, not what a summary field claims", () => {
    const rows = [
      { id: "a", status: "covered" as const },
      { id: "b", status: "covered" as const },
      { id: "c", status: "uncovered" as const },
      { id: "d", status: "declined" as const },
    ];
    expect(summarise(rows)).toEqual({ total: 4, covered: 2, uncovered: 1, declined: 1 });
  });
});

describe("checkLedger", () => {
  test("a row claiming a test that did not run is drift, and says which test", () => {
    // The failure this exists to catch: someone renames a test, or deletes one,
    // and the catalogue goes on claiming the scenario is covered. Nothing else
    // in the repo would notice - the row is prose to every other reader.
    const rows = [
      {
        id: "wait-reply-reaches-the-thread",
        status: "covered" as const,
        testFile: "test/e2e/loop.e2e.ts",
        testName: "agent reply appears in the conversation log",
      },
    ];
    const ran = report("loop.e2e.ts", [["a different name entirely", "expected"]]);

    const problems = checkLedger(rows, ran);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.id).toBe("wait-reply-reaches-the-thread");
    expect(problems[0]?.detail).toContain("agent reply appears in the conversation log");
  });

  test("a skipped test does not cover anything, however green the run looks", () => {
    // The quieter half of the same failure. The test still exists, so a check
    // that only asks "is this name present" passes - and a suite where the
    // scenario's only test is skipped reports 78 passed, 1 skipped and a full
    // ledger. A `test.fail()` declaring behaviour the product lacks is NOT this
    // case: Playwright reports it `expected` when it fails as declared (D-008).
    const rows = [
      {
        id: "the-real-artifact-measured",
        status: "covered" as const,
        testFile: "test/e2e/real-artifact.e2e.ts",
        testName: "the real artifact, measured",
      },
    ];
    const problems = checkLedger(
      rows,
      report("real-artifact.e2e.ts", [["the real artifact, measured", "skipped"]]),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("skipped");
  });

  test("a covered row that names no test is its own failure, not a missing test", () => {
    // Distinct from the case above on purpose. "Covered, but I will not say by
    // what" is a claim nothing can check, and reporting it as `claims a test the
    // run does not contain` sends whoever reads it looking for a test that was
    // never named.
    const problems = checkLedger([{ id: "vague", status: "covered" }], report("loop.e2e.ts", []));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("names no test");
  });

  test("a declined row has to say why, or it is just an unwritten test", () => {
    // `declined` is the only status that closes a scenario without a test. Left
    // reasonless it becomes the cheapest way to make the ledger look finished.
    const problems = checkLedger(
      [
        { id: "no-network", status: "declined", declineReason: "Replaced by a static gate." },
        { id: "quietly-dropped", status: "declined" },
      ],
      report("loop.e2e.ts", []),
    );

    expect(problems.map((p) => p.id)).toEqual(["quietly-dropped"]);
    expect(problems[0]?.problem).toContain("no reason");
  });
});

describe("checkLedger folds the outcomes it is given", () => {
  test("a test skipped in one project and passing in another does not cover it", () => {
    // `spec.tests[]` is one entry per PROJECT. Reading tests[0] made the first
    // project the whole truth, so a scenario skipped everywhere else read as
    // covered. One `chromium` project today; D-026 splits the suite in two.
    const twoProjects = {
      suites: [
        {
          file: "loop.e2e.ts",
          specs: [
            {
              title: "agent reply appears in the conversation log",
              tests: [{ status: "expected" }, { status: "skipped" }],
            },
          ],
        },
      ],
    };
    const problems = checkLedger(
      [
        {
          id: "wait-reply-reaches-the-thread",
          status: "covered",
          testFile: "test/e2e/loop.e2e.ts",
          testName: "agent reply appears in the conversation log",
        },
      ],
      twoProjects,
    );
    expect(problems.map((p) => p.problem)).toEqual(["claims a test that was skipped in this run"]);
  });

  test("a passing namesake does not vouch for a skipped test in the same file", () => {
    // Playwright allows duplicate titles in one file, and the key holds the
    // leaf title only - the describe path is not in it. Last-write-wins let
    // whichever came second decide.
    const duplicated = {
      suites: [
        {
          file: "loop.e2e.ts",
          specs: [
            { title: "same title", tests: [{ status: "skipped" }] },
            { title: "same title", tests: [{ status: "expected" }] },
          ],
        },
      ],
    };
    const problems = checkLedger(
      [
        {
          id: "ambiguous",
          status: "covered",
          testFile: "test/e2e/loop.e2e.ts",
          testName: "same title",
        },
      ],
      duplicated,
    );
    expect(problems).toHaveLength(1);
  });

  test("a defect cannot be filed as a scope choice", () => {
    // M6.2 declined 12 rows whose reason named a measured finding, which reads
    // as "we chose not to test this" for scenarios the product cannot exhibit
    // at all. hostile.e2e.ts's corpus guard caught it; this makes the rule
    // enforceable rather than remembered (D-079).
    const problems = checkLedger(
      [
        {
          id: "hostile-csp-meta",
          status: "declined",
          declineReason:
            "DEFECT-GATED. Finding #42: a document-authored default-src 'none' blocks the bootstrap.",
        },
      ],
      { suites: [] },
    );
    expect(problems.map((p) => p.problem)).toEqual(["is declined but its reason names a finding"]);

    // An ordinary scope decline is untouched - the rule is about reasons that
    // point at a defect, not about declining being suspicious.
    expect(
      checkLedger(
        [
          {
            id: "palette-empty-result",
            status: "declined",
            declineReason: "~0.9s for one string on a no-match query.",
          },
        ],
        { suites: [] },
      ),
    ).toEqual([]);
  });

  test("a non-canonical path cannot buy a row out of the run check", () => {
    // `./test/e2e/loop.e2e.ts` names a real e2e file. Before this guard the
    // leading "./" made it read as "not e2e", so the row skipped the report
    // cross-check entirely while still resolving in the source check - a
    // two-character edit that exempts a row from verification and looks like
    // nothing in a diff.
    const problems = checkLedger(
      [
        {
          id: "sneaky",
          status: "covered",
          testFile: "./test/e2e/loop.e2e.ts",
          testName: "gone",
        },
      ],
      { suites: [] },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toBe("names its test file in a non-canonical form");
  });

  test("a skipped declaration is told apart from a live one", () => {
    // The title is in the source either way, which is exactly why the modifier
    // has to be carried: for a unit-covered row the source is the ONLY witness.
    const source = [
      'test("a live one", () => {});',
      'test.skip("a skipped one", () => {});',
      'test.todo("a todo one");',
      'test.fail("a declared failure", () => {});',
    ].join("\n");
    expect(testDeclarationsIn(source)).toEqual([
      { title: "a live one", modifier: "" },
      { title: "a skipped one", modifier: "skip" },
      { title: "a todo one", modifier: "todo" },
      { title: "a declared failure", modifier: "fail" },
    ]);
    // The older accessor keeps its shape - it is what the drift check used
    // before the modifier existed, and other callers still read it.
    expect(testTitlesIn(source)).toEqual([
      "a live one",
      "a skipped one",
      "a todo one",
      "a declared failure",
    ]);
  });

  test("a row covered by a unit test is not judged by a Playwright report", () => {
    // D-018 routes the unit-shaped scenarios out of e2e. Their tests are real,
    // but they run in `bun test` and are absent from this report by
    // construction - reading that absence as a false coverage claim would
    // punish exactly the move the milestone is making. The check that DOES
    // vouch for them reads their source; it is the drift test below.
    const empty = { suites: [] };
    expect(
      checkLedger(
        [
          {
            id: "alt-modifier-ignored",
            status: "covered",
            testFile: "test/keymap.test.ts",
            testName: "alt disqualifies every chord",
          },
        ],
        empty,
      ),
    ).toEqual([]);

    // The exemption is keyed on the PATH, not on absence: an e2e row missing
    // from the same empty report is still a problem.
    expect(
      checkLedger(
        [
          {
            id: "still-checked",
            status: "covered",
            testFile: "test/e2e/loop.e2e.ts",
            testName: "gone",
          },
        ],
        empty,
      ),
    ).toHaveLength(1);
  });
});

describe("testTitlesIn returns specs, and only specs", () => {
  test("a describe block or a step is not a test that can back a row", () => {
    // The old `test\.\w+` catch-all matched both, so a `describe` title could
    // satisfy a covered row that no test backs.
    const source = [
      'test.describe("a block, not a test", () => {',
      '  test.step("a step, not a test", async () => {});',
      '  test("a real test", async () => {});',
      '  test.skip("a skipped test still declares a spec", async () => {});',
      '  test.fail("a failing-by-declaration test declares one too", async () => {});',
      "});",
    ].join("\n");
    expect(testTitlesIn(source)).toEqual([
      "a real test",
      "a skipped test still declares a spec",
      "a failing-by-declaration test declares one too",
    ]);
  });

  test("a single-quoted title is a spec too - it is how biome writes one containing a quote", () => {
    // The formatter rewrites a title holding a double quote into single
    // quotes, so this shape is canonical output, not a style choice a test
    // author could avoid. A parser blind to it refused a legal title.
    const source = "test('\"+\" deselects the tab you are on', async () => {});";
    expect(testTitlesIn(source)).toEqual(['"+" deselects the tab you are on']);
  });

  test("an interpolated title is not returned, because it cannot be resolved", () => {
    // Returning the raw template would let a row claim a test whose real title
    // never matches it. Not returning it means such a row fails instead, which
    // is the safe direction.
    // Assembled so the interpolation is data here, not a template this file
    // would itself evaluate.
    const interpolation = ["$", "{width}"].join("");
    const source = `  test(\`viewport never scrolls (panel at ${interpolation}px)\`, async () => {});`;
    expect(testTitlesIn(source)).toEqual([]);
  });
});

describe("the mutation debt", () => {
  test("counts covered rows that name no mutation, and does not invent one", () => {
    // D-007 says every test ships a named mutation. The 39 tests this catalogue
    // inherited predate that rule, and there are only two honest options:
    // delete them, or count the debt and refuse to let it grow. Fabricating 39
    // mutations nobody ran would be the third, and it would be a lie in a file
    // whose whole purpose is to stop the ledger lying.
    const rows: CatalogueRow[] = [
      { id: "old", status: "covered", testFile: "a.ts", testName: "a", mutation: null },
      { id: "new", status: "covered", testFile: "b.ts", testName: "b", mutation: "drop the guard" },
      { id: "not-yet", status: "uncovered" },
    ];
    expect(mutationDebt(rows)).toEqual(["old"]);
  });

  test("demoting a grandfathered row does not free a slot for a new one", () => {
    // A ceiling on the COUNT is not a ratchet. Demote one inherited row to
    // uncovered, add a brand-new covered row with no mutation, and the total is
    // unchanged - so a count check passes while exactly the thing it exists to
    // prevent has happened. Membership is the check instead.
    const grandfathered = [...GRANDFATHERED_WITHOUT_MUTATION][0] ?? "";
    expect(grandfathered).not.toBe("");

    const rows: CatalogueRow[] = [
      { id: grandfathered, status: "uncovered" },
      { id: "brand-new", status: "covered", testFile: "a.ts", testName: "a", mutation: null },
    ];
    // The count is one either way; only membership tells them apart.
    expect(mutationDebt(rows)).toEqual(["brand-new"]);
    expect(unmutatedNewcomers(rows)).toEqual(["brand-new"]);
  });

  test("every grandfathered id is a row that really does owe a mutation", async () => {
    // A permission for a row that no longer needs one is a rule outliving its
    // reason - and it would silently cover a future row that reused the id.
    const catalogue = (await Bun.file(join(REPO, "test/e2e/catalogue.json")).json()) as {
      suites: Array<{ scenarios: CatalogueRow[] }>;
    };
    const owed = new Set(mutationDebt(catalogue.suites.flatMap((suite) => suite.scenarios)));
    const stale = [...GRANDFATHERED_WITHOUT_MUTATION].filter((id) => !owed.has(id));
    expect(stale).toEqual([]);
  });
});

describe("the catalogue in this repository", () => {
  test("every covered row names a test that exists in the file it names", async () => {
    // The cross-check against a real run lives in `scripts/coverage-check.ts`
    // and needs Playwright to have run. This is the half that does not: it
    // reads the suite's source, so a renamed or deleted test is red the moment
    // it happens, in `bun test`, without a browser.
    const catalogue = (await Bun.file(join(REPO, "test/e2e/catalogue.json")).json()) as {
      suites: Array<{ scenarios: CatalogueRow[] }>;
    };
    const rows = catalogue.suites.flatMap((suite) => suite.scenarios);
    const covered = rows.filter((row) => row.status === "covered");
    // Not a vacuous count: the migration resolved 39 claims to real titles, and
    // a repo with none would make every assertion below trivially true.
    expect(covered.length).toBeGreaterThan(30);

    const missing: string[] = [];
    const skipped: string[] = [];
    for (const row of covered) {
      const source = await Bun.file(join(REPO, row.testFile ?? "")).text();
      const found = testDeclarationsIn(source).find((d) => d.title === row.testName);
      if (!found) {
        missing.push(`${row.id} -> ${row.testFile} :: ${row.testName}`);
        continue;
      }
      // A skipped test has its title in the source and covers nothing. The
      // Playwright report says so for an e2e row ("claims a test that was
      // skipped in this run"); a unit-covered row is in no report, so this is
      // the only place that can say it. `fail` is exempt - a `test.fail()`
      // that fails as declared is a real assertion (D-008).
      if (found.modifier === "skip" || found.modifier === "todo") {
        skipped.push(`${row.id} -> ${row.testFile} :: ${row.testName} (test.${found.modifier})`);
      }
    }
    expect(missing).toEqual([]);
    expect(skipped).toEqual([]);
  });

  test("the totals are computed, and the hand-written summary is gone", async () => {
    const catalogue = (await Bun.file(join(REPO, "test/e2e/catalogue.json")).json()) as {
      suites: Array<{ scenarios: CatalogueRow[] }>;
      coverageSummary?: unknown;
    };
    // The field said 257 total / 35 covered while the rows said 256 / 39. A
    // number nobody maintains is the thing this milestone removes.
    expect(catalogue.coverageSummary).toBeUndefined();
    const summary = summarise(catalogue.suites.flatMap((suite) => suite.scenarios));
    expect(summary.total).toBe(summary.covered + summary.uncovered + summary.declined);
  });
});
