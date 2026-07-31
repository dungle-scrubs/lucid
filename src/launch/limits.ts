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

/**
 * Which wall was hit. A stable identifier, not the harness's sentence: the
 * consumers of a detection are a retained log line and a viewer warning, and
 * anything the harness happened to print on the matching line - a prompt, a
 * filename, a customer's name - would ride along with the sentence into both
 * (D-005: records carry identifiers and outcomes, never content).
 */
export type UsageLimitKind = "usage-limit" | "session-limit" | "credits" | "quota";

/** The condition in Lucid's own words, framed by each consumer ("Delivery is
 *  paused: the attending harness is …", "The stub harness is …"). One place,
 *  so the create dialog and the attend warning cannot drift. */
export const USAGE_LIMIT_WORDING: Readonly<Record<UsageLimitKind, string>> = {
  "usage-limit": "over its usage limit",
  "session-limit": "over its session limit",
  credits: "out of credits",
  quota: "over its provider quota",
};

const LIMIT_PATTERNS: ReadonlyArray<readonly [RegExp, UsageLimitKind]> = [
  // codex: "You've hit your usage limit. ... try again at Jul 29th ..."
  [/you'?ve hit your usage limit/i, "usage-limit"],
  // claude code: "You've hit your session limit · resets 6:30pm"
  [/you'?ve hit your session limit/i, "session-limit"],
  [/usage limit (?:reached|exceeded)/i, "usage-limit"],
  // credit-metered plans (codex names credits explicitly)
  [/purchase more credits|insufficient credits|out of credits/i, "credits"],
  // google-family (pi's default provider) quota errors
  [/resource_exhausted|quota exceeded|exceeded your current quota/i, "quota"],
];

/**
 * Which usage wall the harness's output reports, or null when nothing in it
 * looks like one. Scanned bottom-up: the error is virtually always the last
 * thing a dying turn printed.
 */
export const detectUsageLimit = (output: string): UsageLimitKind | null => {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    for (const [pattern, kind] of LIMIT_PATTERNS) {
      if (pattern.test(line)) return kind;
    }
  }
  return null;
};
