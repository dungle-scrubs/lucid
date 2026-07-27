/**
 * The mechanical half of freezing the harness surface (M3.3).
 *
 * Every rule here is a coupling that has already cost this suite something, and
 * every one of them is true of the tree as it ships - a gate introduced red is
 * a gate somebody turns off.
 *
 * They are greps rather than a lint plugin on purpose: the thing being
 * prevented is a STRING appearing in a test, which no type system sees, and a
 * grep is a rule the next person can read in ten seconds and argue with.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const SUITES = ["test/e2e"];

interface Rule {
  readonly name: string;
  readonly why: string;
  /** Matches a LINE that breaks the rule. */
  readonly bad?: RegExp;
  /**
   * Matches a violation that can span lines - needs `g`. Used where the
   * formatter splits the thing being matched: `"--timeout",` and its value end
   * up on separate lines, so a line-scoped rule misses the dominant shape.
   */
  readonly whole?: RegExp;
  /** A match that also matches this is allowed, with the reason in `why`. */
  readonly allow?: RegExp;
  /** Files exempt from the rule, by exact repo-relative path. */
  readonly exempt?: readonly string[];
}

/**
 * Strip comments before matching, without eating code.
 *
 * `replace(/\/\/.*$/)` truncated at the first `//`, so a `https://` earlier on
 * the line hid every violation after it. Only a `//` that is not inside a
 * string starts a comment.
 */
const stripComments = (line: string): string => {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === "\\") {
        out += c + (line[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = undefined;
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") break;
    out += c;
  }
  return out.replace(/^\s*\*.*$/, "");
};

const RULES: readonly Rule[] = [
  {
    name: "placeholder-coupled selector",
    why: "A placeholder is UI copy. Somebody rewords it without ever thinking about a test, and the suite goes red for a change that broke nothing.",
    bad: /placeholder[\^*$~]?=|getByPlaceholder\(/,
  },
  {
    name: "class-coupled selector",
    // Narrowed to the generated names on purpose: the suite legitimately uses
    // `.marker` and `.marker.pending`, which are the overlay's own vocabulary
    // rather than styling. Claiming to ban every class while allowing those
    // would be a rule nobody could trust.
    why: "A GENERATED class name (`.css-…`) changes when nothing changes, and a `[class` selector couples a test to styling.",
    bad: /\.locator\([`'"][^`'"]*(?:\.css-|\[class)/,
  },
  {
    name: "hardcoded platform modifier",
    why: 'On Linux `Meta+w` drives a chord the product never receives, and the test passes by asserting nothing happened. Use `chord("w")`.',
    // Both spellings. `modifiers: ["Meta"]` is the same defect as `"Meta+w"` -
    // on Linux it is a modifier the product never receives, and the assertion
    // that nothing happened passes for the wrong reason. Nine live sites were
    // in the tree when this clause was added.
    bad: /["'`]Meta\+|modifiers:\s*\[[^\]]*["']Meta["']/,
    // `ControlOrMeta+` is Playwright's own portable spelling, which is the
    // thing this rule is asking for.
    allow: /ControlOrMeta\+/,
    exempt: ["test/e2e/locators.ts"],
  },
  {
    name: "raw data-test selector",
    why: "Selectors live in locators.ts, so a renamed hook is one edit and a compile error rather than a silent miss in nine files.",
    bad: /\[data-test=/,
    // Two carve-outs, both real, both narrowed after review. `querySelector`
    // and `closest(` are DOM calls that only exist inside a page.evaluate
    // callback, where locators.ts does not. A bare `document.` used to be
    // allowed too, which let `page.locator('[data-test=x]').evaluate(() =>
    // document.title)` through on the strength of a word elsewhere on the line.
    // `hook(` is the composition helper - and it must be the whole selector, so
    // `hook("x") + '[data-test="y"]'` is still an offence.
    allow: /\.querySelector(?:All)?\(|\.closest\(|hook\([^)]*\)[^[]*$/,
    exempt: ["test/e2e/locators.ts"],
  },
  {
    name: "literal timeout in a test body",
    why: "A deadline the harness owns can be scaled for a slow machine or a loaded runner; one typed into a test cannot, and it is the first thing to flake.",
    // Whole-file, not per line: Biome splits `"--timeout", waitTimeoutSeconds(8)`
    // across two lines, which is now the dominant local shape - and a rule that
    // only saw one line missed exactly the form a future test would copy.
    whole: /["']--timeout(?:=\d)?["']\s*(?:,\s*(?:["']\d|String\())?/g,
    // Two legal continuations. `waitTimeoutSeconds` is the scaled deadline. A
    // literal `"0"` is not a deadline at all - it is the drain-and-return
    // contract itself (the m4.1 wait fix), and scaling has no meaning at zero.
    allow: /waitTimeoutSeconds\(|^["']--timeout["']\s*,\s*["']0["']/,
  },
];

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(REPO, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
};

const main = async (): Promise<number> => {
  const offences: string[] = [];
  for (const suite of SUITES) {
    for (const path of await walk(suite)) {
      const rel = path.slice(REPO.length + 1);
      const text = await readFile(path, "utf8");
      const lines = text.split("\n").map(stripComments);
      const code = lines.join("\n");
      for (const rule of RULES) {
        // Exact paths. `endsWith` exempted any file called `*locators.ts`,
        // so `my-locators.ts` could hold anything.
        if (rule.exempt?.includes(rel)) continue;
        if (rule.bad) {
          lines.forEach((line, i) => {
            if (!rule.bad?.test(line)) return;
            if (rule.allow?.test(line)) return;
            offences.push(`${rel}:${i + 1}  ${rule.name}\n      ${line.trim().slice(0, 100)}`);
          });
        }
        if (rule.whole) {
          rule.whole.lastIndex = 0;
          for (const m of code.matchAll(rule.whole)) {
            // The window is what follows the match, because the value the rule
            // cares about is what comes AFTER the flag.
            const after = code.slice(m.index, m.index + 120);
            if (rule.allow?.test(after)) continue;
            const line = code.slice(0, m.index).split("\n").length;
            offences.push(`${rel}:${line}  ${rule.name}\n      ${m[0].trim().slice(0, 80)}`);
          }
        }
      }
    }
  }

  if (offences.length > 0) {
    console.error(`${offences.length} coupled selectors:\n`);
    for (const o of offences) console.error(`  ${o}`);
    console.error("\nWhy each rule exists:");
    for (const rule of RULES) console.error(`  ${rule.name}: ${rule.why}`);
    return 1;
  }
  console.log(`${RULES.length} selector rules hold across ${SUITES.join(", ")}`);
  return 0;
};

if (import.meta.main) process.exit(await main());
