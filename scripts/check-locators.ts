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
  /** Matches a line that breaks the rule. */
  readonly bad: RegExp;
  /** A line that matches this is allowed anyway, with the reason in `why`. */
  readonly allow?: RegExp;
  /** Files exempt from the rule, by path suffix. */
  readonly exempt?: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    name: "placeholder-coupled selector",
    why: "A placeholder is UI copy. Somebody rewords it without ever thinking about a test, and the suite goes red for a change that broke nothing.",
    bad: /placeholder[\^*$~]?=/,
  },
  {
    name: "class-coupled selector",
    why: "A class name changes when a style does. `.css-` in particular is a generated name that changes when nothing changes.",
    bad: /\.locator\([`'"][^`'"]*(?:\.css-|\[class)/,
  },
  {
    name: "hardcoded platform modifier",
    why: 'On Linux `Meta+w` drives a chord the product never receives, and the test passes by asserting nothing happened. Use `chord("w")`.',
    bad: /["'`]Meta\+/,
    // `ControlOrMeta+` is Playwright's own portable spelling, which is the
    // thing this rule is asking for.
    allow: /ControlOrMeta\+/,
    exempt: ["locators.ts"],
  },
  {
    name: "raw data-test selector",
    why: "Selectors live in locators.ts, so a renamed hook is one edit and a compile error rather than a silent miss in nine files.",
    bad: /\[data-test=/,
    // Two carve-outs, both real. `document.` and `querySelector`/`closest` run
    // INSIDE the browser via page.evaluate, where locators.ts does not exist.
    // `hook(` is the composition helper locators.ts exports for a hook narrowed
    // by a state attribute.
    allow: /document\.|querySelector|closest\(|hook\(/,
    exempt: ["locators.ts"],
  },
  {
    name: "literal timeout in a test body",
    why: "A deadline the harness owns can be scaled for a slow machine or a loaded runner; one typed into a test cannot, and it is the first thing to flake.",
    bad: /["']--timeout["']\s*,\s*["']\d/,
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
      const lines = text.split("\n");
      for (const rule of RULES) {
        if (rule.exempt?.some((suffix) => rel.endsWith(suffix))) continue;
        lines.forEach((line, i) => {
          // Comments describe the rule as often as they break it.
          const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          if (!rule.bad.test(code)) return;
          if (rule.allow?.test(code)) return;
          offences.push(`${rel}:${i + 1}  ${rule.name}\n      ${code.trim().slice(0, 100)}`);
        });
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
