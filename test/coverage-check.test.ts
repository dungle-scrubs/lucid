import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type CatalogueRow,
  checkLedger,
  mutationDebt,
  summarise,
  testTitlesIn,
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
    for (const row of covered) {
      const source = await Bun.file(join(REPO, row.testFile ?? "")).text();
      if (!testTitlesIn(source).includes(row.testName ?? "")) {
        missing.push(`${row.id} -> ${row.testFile} :: ${row.testName}`);
      }
    }
    expect(missing).toEqual([]);
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
