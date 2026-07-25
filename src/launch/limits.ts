/**
 * Usage-limit detection across harness CLIs. Every harness prints its wall in
 * its own words; what the human needs is the same in all cases - "this
 * harness is out of budget, nothing you do in Lucid will work until it
 * resets" - so the patterns live in ONE place and every consumer (the create
 * dialog, the attend engine) says it clearly instead of shrugging at an exit
 * code.
 *
 * Deliberately usage-limits only: a transient 429 rate limit retries fine on
 * its own and must not read as "give up until the plan resets".
 */

const LIMIT_PATTERNS: readonly RegExp[] = [
  // codex: "You've hit your usage limit. ... try again at Jul 29th ..."
  /you'?ve hit your usage limit/i,
  // claude code: "You've hit your session limit · resets 6:30pm"
  /you'?ve hit your session limit/i,
  /usage limit (?:reached|exceeded)/i,
  // credit-metered plans (codex names credits explicitly)
  /purchase more credits|insufficient credits|out of credits/i,
  // google-family (pi's default provider) quota errors
  /resource_exhausted|quota exceeded|exceeded your current quota/i,
];

/**
 * The harness's own limit line from its output, or null when nothing in it
 * looks like a usage wall. Scanned bottom-up: the error is virtually always
 * the last thing a dying turn printed.
 */
export const detectUsageLimit = (output: string): string | null => {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    for (const p of LIMIT_PATTERNS) {
      if (p.test(line)) return line.slice(0, 300);
    }
  }
  return null;
};
