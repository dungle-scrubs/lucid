import { describe, expect, test } from "bun:test";
import { matchScore } from "../client/chrome/list.ts";

describe("matchScore: typing finds what you meant, not what happens to contain the letters", () => {
  const taxes =
    "2025 US tax checklist 2025-tax-checklist.html taxes /Users/kevin/dev/taxes/.lucid/2025-tax-checklist.html";
  const artifactFirst =
    "Artifact-first: the next Lucid model artifact-first.html .lucid /Users/kevin/dev/lucid-artifacts/.lucid/artifact-first.html";
  const migration = "Migration plan plan.html hub /Users/kevin/dev/hub/.lucid/plan.html";

  /**
   * The measured case. cmdk's default scorer is a bare subsequence test, and
   * the value ends with an absolute path - so "taxes" matched
   * `Ar*t*if*a*ct-first: the ne*x*t Lucid mod*e*l ...artifact-fir*s*t`, five
   * letters gathered from a hundred characters, and the pick screen offered an
   * unrelated document. Scattered letters are a coincidence, and a longer
   * haystack makes them likelier, not more relevant.
   */
  test("scattered letters across a long path do NOT match", () => {
    expect(matchScore(artifactFirst, "taxes")).toBe(0);
  });

  test("the row the human meant scores, and outranks the coincidence", () => {
    expect(matchScore(taxes, "taxes")).toBeGreaterThan(0);
    expect(matchScore(taxes, "taxes")).toBeGreaterThan(matchScore(artifactFirst, "taxes"));
  });

  test("abbreviations still work - a TIGHT subsequence is deliberate", () => {
    expect(matchScore(migration, "migplan")).toBeGreaterThan(0);
    expect(matchScore(migration, "mgn")).toBeGreaterThan(0);
  });

  test("a contiguous hit outranks a subsequence one", () => {
    expect(matchScore(migration, "migration")).toBeGreaterThan(matchScore(migration, "mgn"));
  });

  test("a hit at a word boundary outranks one buried mid-word", () => {
    // What a human thinks they typed is the start of a word.
    expect(matchScore("plan alpha", "alpha")).toBeGreaterThan(matchScore("planalpha x", "alpha"));
  });

  test("several terms all have to land - and need not be adjacent", () => {
    expect(matchScore(taxes, "tax check")).toBeGreaterThan(0);
    expect(matchScore(taxes, "tax zebra")).toBe(0);
  });

  test("an empty query keeps every row", () => {
    expect(matchScore(taxes, "")).toBeGreaterThan(0);
    expect(matchScore(taxes, "   ")).toBeGreaterThan(0);
  });

  test("matching is case- and order-insensitive in the ways typing is", () => {
    expect(matchScore(taxes, "TAXES")).toBeGreaterThan(0);
    expect(matchScore(taxes, "checklist tax")).toBeGreaterThan(0);
  });

  test("nothing in common is 0, not a weak match", () => {
    expect(matchScore(taxes, "zzzz")).toBe(0);
  });
});
