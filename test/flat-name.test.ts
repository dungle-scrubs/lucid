import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { flatName } from "../src/plan/render.ts";

/**
 * Distinct documents must get distinct artifact names, and this file is what
 * holds that up.
 *
 * The claim is collision RESISTANCE, not proof: the name is a lossy readable
 * slug plus a digest over the canonical (segments, stem) pair. Proof is not
 * what makes it safe - `runPlanRender` refusing to overwrite an artifact
 * rendered from a different doc is, so even a digest collision is a refusal
 * rather than a silent merge. That matters because a silent collision attaches
 * the next `lucid open` to the FIRST document's review history: the basename
 * is unchanged, so the stem-collision guard sees its own owner and passes.
 *
 * Three hand-rolled reversible encodings preceded this one. Each passed its
 * own targeted tests and each was broken by an input nobody had written down.
 * So the check is a brute-force sweep over an alphabet built from the
 * encodings' special characters, not a list of cases. The targeted tests below
 * keep their value as regressions - they name the layouts that actually broke -
 * but the sweep is what makes the property a property.
 */

/** Same directory, different spelling: these SHOULD share a name. */
const canonicalDir = (relDir: string): string =>
  relDir
    .split(sep)
    .filter((s) => s !== "" && s !== ".")
    .join(sep);

describe("flatName gives distinct docs distinct names", () => {
  test("a brute-force sweep over the encoding's own special characters finds no collision", () => {
    // Every character the encoding assigns meaning to, plus the tokens it
    // emits - `dot`, `-0`, `-1`, `-2` - so an input can spell an output token
    // if the scheme lets it.
    const alphabet = ["a", "-", ".", "dot", "dot-", "-a", "a-", "0", "1", "2", "-0", "-1", "-2"];

    const dirs: string[] = [""];
    for (const one of alphabet) {
      dirs.push(one);
      for (const two of alphabet) dirs.push(`${one}${sep}${two}`);
    }

    const seen = new Map<string, string>();
    let checked = 0;
    for (const relDir of dirs) {
      for (const stem of alphabet) {
        checked++;
        // Key on the CANONICAL pair: `a/./b` and `a/b` are the same directory,
        // so sharing a name is correct and must not read as a collision.
        const key = JSON.stringify([canonicalDir(relDir), stem]);
        const name = flatName(relDir, stem);
        const prior = seen.get(name);
        if (prior !== undefined && prior !== key) {
          throw new Error(`collision: ${prior} and ${key} both spell ${JSON.stringify(name)}`);
        }
        seen.set(name, key);
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  /**
   * The layouts that actually broke, kept as named regressions. Each passed
   * the encoding of its day.
   */
  test.each([
    // doubling scheme, round 1: leading dots were dropped
    [".plans", "implementation", "plans", "implementation"],
    // round 1: `-` was both separator and legal segment character
    ["a-b", "c", "a", "b-c"],
    // round 1: the dir/file boundary was erased
    ["plans/05", "impl", "plans", "05-impl"],
    // round 2: `dot-` marker vs a directory literally named `dot`
    [".plans", "x", `dot${sep}plans`, "x"],
    // round 2: a hyphen run straddling a boundary has two legal parses
    ["p-", "q", "p", "-q"],
    // round 2: `.a` at the root vs `dot/a`
    [".a", "x", "dot", "a-x"],
  ])("%s/%s does not collide with %s/%s", (d1, s1, d2, s2) => {
    expect(flatName(d1, s1)).not.toBe(flatName(d2, s2));
  });

  test("a backslash is an ordinary filename character, not a separator", () => {
    // POSIX: `a\b` is ONE directory. Splitting on it made it and the nested
    // pair `a/b` one name.
    if (sep !== "/") return; // on Windows it genuinely is a separator
    expect(flatName("a\\b", "x")).not.toBe(flatName(`a${sep}b`, "x"));
  });

  test("the same directory spelled differently keeps ONE name", () => {
    expect(flatName("", "notes")).toBe(flatName(".", "notes"));
    expect(flatName(`a${sep}${sep}b`, "x")).toBe(flatName(`a${sep}b`, "x"));
    expect(flatName(`a${sep}.${sep}b`, "x")).toBe(flatName(`a${sep}b`, "x"));
  });

  test("the truncated branch stays injective through its digest", () => {
    const long = "x".repeat(300);
    expect(flatName(`${long}${sep}a`, "impl")).not.toBe(flatName(`${long}${sep}b`, "impl"));
    // And the digest keys on the PAIR, not on a concatenation that is itself
    // ambiguous over it.
    expect(flatName(`${long}${sep}a`, "b")).not.toBe(flatName(long, `a${sep}b`));
  });
});
