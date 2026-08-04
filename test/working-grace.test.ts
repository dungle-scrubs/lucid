import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKING_GRACE_MS } from "../src/core/fold.ts";
import { WORKING_GRACE_MS as workingGrace } from "../client/chrome/working.ts";

/**
 * plan 04, M1.3 (D-010): the ten-minute grace number lived in two places -
 * `WORKING_STALE_MS` (client/chrome/working.ts) and `DEFAULT_WORKING_GRACE_MS`
 * (src/server/attend.ts). Same number, two owners, and a review that keeps
 * re-suggesting they be unified. They are one CONSTANT now (core/fold.ts) while
 * the two PREDICATES that read it stay apart deliberately - the viewer measures
 * from the oldest open turn's `heardAt` (segment-scoped), attend measures from
 * the newest ack of any turn over the whole log with an injectable grace.
 */

const REPO = join(import.meta.dirname, "..");

describe("the stale-window grace constant", () => {
  test("is owned once in core/fold.ts", () => {
    expect(WORKING_GRACE_MS).toBe(10 * 60 * 1000);
  });

  test("working.ts reads fold's binding, not its own copy", () => {
    // Re-exported, so this is the same binding (not merely the same value).
    expect(workingGrace).toBe(WORKING_GRACE_MS);

    const working = readFileSync(join(REPO, "client/chrome/working.ts"), "utf8");
    const attend = readFileSync(join(REPO, "src/server/attend.ts"), "utf8");

    // No local ten-minute literal remains in either file: both import the one
    // constant. (A regex, because the thing being prevented is a NUMBER a type
    // system cannot see - the same reason check-locators is a grep.)
    const graceLiteral = /\b10\s*\*\s*60\s*\*\s*1000\b/;
    expect(graceLiteral.test(working), "working.ts still owns a grace literal").toBe(false);
    expect(graceLiteral.test(attend), "attend.ts still owns a grace literal").toBe(false);

    // Both import the shared constant.
    expect(working).toContain("WORKING_GRACE_MS");
    expect(attend).toContain("WORKING_GRACE_MS");
  });

  test("attend's grace stays injectable (the stub harness overrides it)", () => {
    // The option exists and defaults to the shared constant; the harness suite
    // injects a smaller value. Asserting the option name is present keeps a
    // rename from silently stranding the stub suite.
    const attend = readFileSync(join(REPO, "src/server/attend.ts"), "utf8");
    expect(attend).toContain("workingGraceMs");
    expect(attend).toContain("options.workingGraceMs ?? WORKING_GRACE_MS");
  });
});
