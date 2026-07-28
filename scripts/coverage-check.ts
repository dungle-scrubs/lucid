/**
 * The scenario ledger, recomputed and cross-checked.
 *
 * `test/e2e/catalogue.json` says which of the catalogued scenarios are covered
 * and by which test. Nothing stopped that from being wrong: the numbers were
 * hand-written and the test names were prose, so a renamed test, a deleted one,
 * or a row claiming coverage that never existed all read exactly like progress.
 *
 * This recomputes the totals from the rows and checks every `covered` row
 * against Playwright's own JSON report - the run that just happened, not a
 * memory of one.
 */

export type ScenarioStatus = "covered" | "uncovered" | "declined";

export interface CatalogueRow {
  readonly id: string;
  readonly status: ScenarioStatus;
  /** Repo-relative, e.g. `test/e2e/loop.e2e.ts`. Required when covered. */
  readonly testFile?: string;
  /** The Playwright test title, verbatim. Required when covered. */
  readonly testName?: string;
  /** Why this scenario will never get a test. Required when declined. */
  readonly declineReason?: string;
  /** The named one-line source edit that turns the test red (D-007). */
  readonly mutation?: string | null;
}

/** One thing the ledger claims that the run does not support. */
export interface LedgerProblem {
  readonly id: string;
  readonly problem: string;
  readonly detail: string;
}

/**
 * Playwright's JSON report, narrowed to what a ledger check needs. Suites nest
 * one level per `describe`, and `file` is relative to `testDir`.
 */
interface ReportSpec {
  readonly title: string;
  readonly tests?: ReadonlyArray<{ readonly status?: string }>;
}
interface ReportSuite {
  readonly file?: string;
  readonly specs?: readonly ReportSpec[];
  readonly suites?: readonly ReportSuite[];
}
export interface PlaywrightReport {
  readonly suites?: readonly ReportSuite[];
  readonly stats?: { readonly startTime?: string };
}

/** The key separator. A named constant so it is never typed by hand: this file
 *  once carried three RAW control bytes where a separator was intended, which
 *  made git treat the whole script as binary and show zero lines of it in its
 *  own pull request. */
const KEY_SEP = "\u001f";

/**
 * Every test the run actually contains, keyed `<file> KEY_SEP <title>`, with
 * the outcome Playwright recorded for it.
 *
 * Two foldings, both because the worst outcome is the true one:
 *
 * `spec.tests[]` is one entry per PROJECT, not per retry - retries live inside
 * `tests[].results[]`, and `tests[].status` is already the retry-aware verdict.
 * Reading `tests[0]` would mean a test skipped in every project but the first
 * reads as covered. Not reachable today with one `chromium` project, and
 * reachable the moment D-026's parallel/serial split lands.
 *
 * Duplicate titles in one file are legal in Playwright, and `spec.title` is the
 * leaf title only - the `describe` path is not in the key - so one title can
 * appear twice under different blocks. Last-write-wins would let a passing
 * namesake vouch for a skipped scenario.
 */
const testsInReport = (report: PlaywrightReport): Map<string, string> => {
  const found = new Map<string, string>();
  // Worst first. An unrecognised status sorts last: it is not evidence of a
  // pass, but it is not evidence of a skip either.
  const SEVERITY = ["skipped", "missing", "unexpected", "flaky", "expected"];
  const rank = (status: string): number => {
    const at = SEVERITY.indexOf(status);
    return at === -1 ? SEVERITY.length : at;
  };
  const worse = (a: string, b: string): string => (rank(a) <= rank(b) ? a : b);
  const walk = (suite: ReportSuite, file: string | undefined): void => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      if (here === undefined) continue;
      const perProject = (spec.tests ?? []).map((test) => test.status ?? "missing");
      const status = perProject.length === 0 ? "missing" : perProject.reduce(worse);
      const key = `${here}${KEY_SEP}${spec.title}`;
      const seen = found.get(key);
      found.set(key, seen === undefined ? status : worse(seen, status));
    }
    for (const nested of suite.suites ?? []) walk(nested, here);
  };
  for (const suite of report.suites ?? []) walk(suite, undefined);
  return found;
};

/**
 * The Playwright test titles declared in one source file, as literals.
 *
 * Reading the source rather than a run is what lets a renamed test be caught by
 * `bun test`, before anyone starts a browser.
 *
 * Only the forms that declare a SPEC: `test`, and the modifiers `only`, `skip`,
 * `fail` and `fixme`. Not `test.describe` (a block, whose title is not a spec
 * title and is not in the report's key) and not `test.step` (a step inside one).
 * A `test.\w+` catch-all matched all of those, which let a `describe` title
 * satisfy a covered row that no test backs.
 *
 * A title built by interpolation - `overflow.e2e.ts` has one, parameterised by
 * viewport width - cannot be resolved without running the suite, so it is not
 * returned. The effect is that such a test cannot back a `covered` row: a row
 * naming it fails this check. That is the safe direction, and it is a real
 * limit rather than the prefix matching an earlier version of this comment
 * claimed, which never existed.
 */
export interface TestDeclaration {
  readonly title: string;
  /** `test.skip` -> "skip". Empty string for a plain `test(`. */
  readonly modifier: string;
}

/**
 * Every `test(...)` declaration in a suite's source, with its modifier.
 *
 * The modifier is carried because a SKIPPED test still has its title in the
 * source: for an e2e row the Playwright report catches that (a skipped test
 * covers nothing), but a unit-covered row is not in any report, so without
 * this the title alone would vouch for a test that never runs.
 */
export const testDeclarationsIn = (source: string): TestDeclaration[] => {
  const found: TestDeclaration[] = [];
  // Three quote shapes, not two: biome rewrites a title CONTAINING a double
  // quote into single quotes, so `test('"+" deselects…')` is the formatter's
  // own canonical output - a parser blind to it refused a legal title.
  for (const match of source.matchAll(
    /^[ \t]*test(?:\.(only|skip|fail|fixme|todo))?\(\s*(?:`([^`${]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gm,
  )) {
    const raw = match[2] ?? match[3] ?? match[4];
    if (raw !== undefined) {
      found.push({
        title: raw.replace(/\\"/g, '"').replace(/\\'/g, "'"),
        modifier: match[1] ?? "",
      });
    }
  }
  return found;
};

export const testTitlesIn = (source: string): string[] =>
  testDeclarationsIn(source).map((d) => d.title);

/** Playwright reports files relative to `testDir` (`test/e2e`); the catalogue
 *  stores them repo-relative, because that is what a human can open. */
const reportPath = (testFile: string): string => testFile.replace(/^test\/e2e\//, "");

/** Repo-relative and free of "./" and "../" segments. The ledger's paths are
 *  compared by prefix, so a non-canonical spelling changes their meaning. */
export const canonicalPath = (testFile: string): string =>
  testFile.replace(/^(?:\.\/)+/, "").replace(/\/(?:\.\/)+/g, "/");

/**
 * Everything the ledger claims that this run does not support.
 *
 * Empty means the catalogue and the suite agree. It is deliberately not a
 * boolean: the point is to name the row and the test, because "coverage drifted"
 * is not something anyone can act on.
 */
export const checkLedger = (
  rows: readonly CatalogueRow[],
  report: PlaywrightReport,
): readonly LedgerProblem[] => {
  const ran = testsInReport(report);
  const problems: LedgerProblem[] = [];
  for (const row of rows) {
    if (row.status === "declined") {
      if ((row.declineReason ?? "").trim() === "") {
        problems.push({
          id: row.id,
          problem: "is declined with no reason given",
          detail: "`declined` is the only status that closes a scenario without a test",
        });
      }
      continue;
    }
    if (row.status !== "covered") continue;
    if (!row.testFile || !row.testName) {
      problems.push({
        id: row.id,
        problem: "is covered but names no test",
        detail: `testFile=${row.testFile ?? "(none)"} testName=${row.testName ?? "(none)"}`,
      });
      continue;
    }
    // The prefix below is a string compare, so the SPELLING of the path
    // decides which check a row answers to. `./test/e2e/loop.e2e.ts` names a
    // real e2e file, reads as "not e2e" here, and resolves fine in the source
    // check - a two-character edit that exempts a row from run-verification
    // while looking untouched. A path that is not already canonical is a
    // ledger problem in its own right, not something to normalise silently.
    if (row.testFile !== canonicalPath(row.testFile)) {
      problems.push({
        id: row.id,
        problem: "names its test file in a non-canonical form",
        detail: `${row.testFile} should be written as ${canonicalPath(row.testFile)} - the leading "./" or "../" changes which checks the row answers to`,
      });
      continue;
    }

    // A row covered by a UNIT test (D-018 routes the unit-shaped out of e2e)
    // cannot be vouched for by a Playwright report - it was never in the run.
    // Skipping it here is not an exemption: `test/coverage-check.test.ts`
    // reads every covered row's file, asserts the named test exists in its
    // SOURCE, and asserts it is not `test.skip`/`test.todo` - that second half
    // is what makes it a real substitute rather than a weaker cousin, because
    // a skipped test keeps its title in the source and would otherwise vouch
    // for itself. Counted separately in the summary so the exemption stays
    // visible rather than silent.
    if (!row.testFile.startsWith("test/e2e/")) continue;

    // Both are non-empty here: the guard above is what makes them so.
    const status = ran.get(`${reportPath(row.testFile)}${KEY_SEP}${row.testName}`);
    // `expected` covers both a pass and a `test.fail()` that failed as declared
    // (D-008). `unexpected` means the suite is red, which is already somebody's
    // problem and not a false claim about coverage. `skipped` covers nothing.
    if (status === "skipped") {
      problems.push({
        id: row.id,
        problem: "claims a test that was skipped in this run",
        detail: `${row.testFile} :: ${row.testName}`,
      });
    } else if (status === undefined) {
      problems.push({
        id: row.id,
        problem: "claims a test the run does not contain",
        detail: `${row.testFile} :: ${row.testName}`,
      });
    }
  }
  return problems;
};

/**
 * Covered scenarios whose row names no mutation: the ids.
 *
 * D-007 requires every test to ship a named one-line source edit that turns it
 * red. The 39 tests this catalogue inherited predate that rule and no such edit
 * was ever run against them, so there are two honest options - delete them, or
 * record the debt and refuse to let it grow. Writing 39 plausible mutations
 * nobody executed would be a third, and it would be a fabrication in the one
 * file whose purpose is to stop the ledger claiming things that were not done.
 *
 * Returned as ids rather than a number so the caller can name them - and,
 * more importantly, so the caller can check WHICH rows they are. See
 * `GRANDFATHERED`.
 */
export const mutationDebt = (rows: readonly CatalogueRow[]): string[] =>
  rows
    .filter((row) => row.status === "covered" && (row.mutation ?? "").trim() === "")
    .map((row) => row.id);

export interface CoverageSummary {
  readonly total: number;
  readonly covered: number;
  readonly uncovered: number;
  readonly declined: number;
}

/** Totals derived from the rows. The only totals there are. */
export const summarise = (rows: readonly CatalogueRow[]): CoverageSummary => ({
  total: rows.length,
  covered: rows.filter((row) => row.status === "covered").length,
  uncovered: rows.filter((row) => row.status === "uncovered").length,
  declined: rows.filter((row) => row.status === "declined").length,
});

/**
 * The covered rows that carried no mutation when the ledger became executable.
 *
 * Named, not counted. A ceiling on the NUMBER is not a ratchet: demote one of
 * these to `uncovered` and a brand-new unmutated row takes its slot with the
 * count unchanged, which is exactly the laundering the ledger exists to stop.
 * Membership is the check - a covered row without a mutation fails unless it is
 * one of these, whatever the total has done in the meantime.
 *
 * This list may shrink and may never grow. Each entry earns its removal by
 * someone naming the one-line edit that turns its test red, and running it.
 */
export const GRANDFATHERED_WITHOUT_MUTATION: ReadonlySet<string> = new Set([
  "add-folder-paste-path",
  "ask-group-answer-round-trip",
  "ask-group-from-stdin",
  "ask-option-parsing-edges",
  "boot-s-opens-tab",
  "context-derives-and-clamps",
  "context-live-vs-sidecar",
  "drawer-counts-and-plurals",
  "drawer-header-has-add-folder-only",
  "drawer-opens-whole-project",
  "end-while-viewer-open",
  "full-agent-loop-happy-path",
  "hub-drop-reports-once-then-exits-cleanly",
  "idle-suspend-and-resume",
  "intent-reply-vs-revise-copy",
  "launch-invalid-registry",
  "launch-spawns-per-fork",
  "multi-spot-chip-remove-keeps-draft",
  "open-stale-descriptor-recovered",
  "outbox-drains-in-authored-order",
  "outbox-survives-a-restart-and-self-drains",
  "palette-opens-and-opens-a-session",
  "pick-opens-note-composer-focused",
  "picker-all-open-scoped-copy",
  "picker-empty-names-its-roots",
  "picker-hides-open-artifacts",
  "picker-row-truly-hittable",
  "progress-cleared-by-real-output",
  "scope-clear-widens-picker",
  "scope-hides-other-projects",
  "shell-under-the-panel-hidden-tabs-stay-mounted",
  "stale-viewer-never-crosses-into-another-session",
  "tabbar-contrast-both-themes",
  "theme-applies-to-every-open-tab",
  "toggling-off-last-spot-discards-note-and-images",
  "wait-model-effort-env-displayed",
  "wait-no-cursor-bootstrap-does-not-ack",
  "wait-reply-reaches-the-thread",
  "wait-reply-with-dead-server-survives",
]);

/** Covered rows naming no mutation that were never grandfathered - the ones
 *  D-007 applies to in full. */
export const unmutatedNewcomers = (rows: readonly CatalogueRow[]): string[] =>
  mutationDebt(rows).filter((id) => !GRANDFATHERED_WITHOUT_MUTATION.has(id));

const CATALOGUE = "test/e2e/catalogue.json";
const REPORT = "test-results/results.json";

/** When the newest thing under `test/e2e/` was last written. A report older
 *  than this was judging a suite that no longer exists. */
const newestSourceMtime = async (): Promise<number> => {
  const { readdir, stat } = await import("node:fs/promises");
  const entries = await readdir("test/e2e", { withFileTypes: true, recursive: true });
  let newest = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const info = await stat(`${entry.parentPath}/${entry.name}`);
    newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
};

/**
 * `bun run scripts/coverage-check.ts [--report <path>] [--no-report]`
 *
 * Exits non-zero on any drift. `--no-report` checks only what can be checked
 * without a run - and says so, because a check that quietly does half its job
 * on a missing file is how a ledger stops being true.
 */
const main = async (argv: readonly string[]): Promise<number> => {
  const noReport = argv.includes("--no-report");
  const reportAt = argv[argv.indexOf("--report") + 1];
  const reportPath = argv.includes("--report") && reportAt ? reportAt : REPORT;

  const catalogue = (await Bun.file(CATALOGUE).json()) as {
    suites: Array<{ scenarios: CatalogueRow[] }>;
    coverageSummary?: unknown;
  };
  const rows = catalogue.suites.flatMap((suite) => suite.scenarios);
  const summary = summarise(rows);
  const failures: string[] = [];

  console.log(
    `ledger: ${summary.total} scenarios, ${summary.covered} covered, ` +
      `${summary.uncovered} uncovered, ${summary.declined} declined`,
  );

  if (catalogue.coverageSummary !== undefined) {
    failures.push(
      "catalogue.json has a hand-written coverageSummary again; the rows are the total",
    );
  }

  // A status nobody recognises - `coverd` - belongs to no bucket, so every
  // count stays plausible and the row is checked by nothing.
  const bucketed = summary.covered + summary.uncovered + summary.declined;
  if (bucketed !== summary.total) {
    const known: ScenarioStatus[] = ["covered", "uncovered", "declined"];
    const strays = rows.filter((row) => !known.includes(row.status)).map((row) => row.id);
    failures.push(
      `${summary.total - bucketed} rows carry a status that is not covered, uncovered or ` +
        `declined: ${strays.join(", ")}`,
    );
  }

  const debt = mutationDebt(rows);
  const newcomers = unmutatedNewcomers(rows);
  if (newcomers.length > 0) {
    failures.push(
      `${newcomers.length} covered scenarios name no mutation and were never ` +
        `grandfathered (D-007): ${newcomers.join(", ")}`,
    );
  }
  // Named individually, because a grandfathered row that no longer exists is a
  // rule outliving its reason - the same staleness the env policy checks for.
  const settled = [...GRANDFATHERED_WITHOUT_MUTATION].filter((id) => !debt.includes(id));
  if (settled.length > 0) {
    failures.push(
      `${settled.length} rows are still listed as grandfathered but no longer owe a ` +
        `mutation. Remove them from GRANDFATHERED_WITHOUT_MUTATION: ${settled.join(", ")}`,
    );
  }

  if (noReport) {
    console.log("cross-check against a run: SKIPPED (--no-report)");
  } else {
    const file = Bun.file(reportPath);
    if (!(await file.exists())) {
      failures.push(
        `no Playwright report at ${reportPath}. Run the suite first, or pass --no-report ` +
          "and accept that no covered row was checked against anything.",
      );
    } else {
      const report = (await file.json()) as PlaywrightReport;
      // The docstring says "the run that just happened, not a memory of one",
      // and without this that is only true by luck. A report older than the
      // suite it is judging describes tests that have since changed - the same
      // failure 867520e refuses for the bundle, in the same repo, one directory
      // over. CI always has a fresh one; a developer is one edit away from not.
      const ranAt = Date.parse(report.stats?.startTime ?? "");
      const newestSource = await newestSourceMtime();
      if (!Number.isNaN(ranAt) && newestSource > ranAt) {
        failures.push(
          `${reportPath} is older than the suite it judges (run at ` +
            `${new Date(ranAt).toISOString()}, newest e2e source ` +
            `${new Date(newestSource).toISOString()}). Re-run the suite.`,
        );
      }
      const problems = checkLedger(rows, report);
      for (const problem of problems) {
        failures.push(`${problem.id} ${problem.problem}: ${problem.detail}`);
      }
      const covered = rows.filter((row) => row.status === "covered");
      const byUnit = covered.filter((row) => !(row.testFile ?? "").startsWith("test/e2e/"));
      const distinct = new Set(covered.map((row) => `${row.testFile}${KEY_SEP}${row.testName}`))
        .size;
      console.log(
        `cross-checked ${covered.length - byUnit.length} covered rows against ${reportPath} ` +
          `(${distinct} distinct tests back all ${covered.length}); ` +
          `${byUnit.length} are covered by unit tests, which this report cannot see - ` +
          `test/coverage-check.test.ts checks those against their source`,
      );
    }
  }

  console.log(
    `mutation debt: ${debt.length} covered rows name no mutation ` +
      `(${GRANDFATHERED_WITHOUT_MUTATION.size} grandfathered, ${newcomers.length} not)`,
  );
  if (failures.length > 0) {
    console.error(`\nledger drift (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log("the catalogue and the suite agree");
  return 0;
};

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
