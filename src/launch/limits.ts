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
export type UsageLimitKind = "usage-limit" | "session-limit" | "weekly-limit" | "credits" | "quota";

/** The condition in Lucid's own words, framed by each consumer ("Delivery is
 *  paused: the attending harness is …", "The stub harness is …"). One place,
 *  so the create dialog and the attend warning cannot drift. */
export const USAGE_LIMIT_WORDING: Readonly<Record<UsageLimitKind, string>> = {
  "usage-limit": "over its usage limit",
  "session-limit": "over its session limit",
  "weekly-limit": "over its weekly usage limit",
  credits: "out of credits",
  quota: "over its provider quota",
};

const LIMIT_PATTERNS: ReadonlyArray<readonly [RegExp, UsageLimitKind]> = [
  // codex: "You've hit your usage limit. ... try again at Jul 29th ..."
  [/you'?ve hit your usage limit/i, "usage-limit"],
  // claude code: "You've hit your session limit · resets 6:30pm"
  [/you'?ve hit your session limit/i, "session-limit"],
  // claude code: "You've hit your weekly limit · resets 2am (Asia/Bangkok)"
  [/you'?ve hit your weekly limit/i, "weekly-limit"],
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

/**
 * Which auth wall was hit. Separate from a usage limit because the remedy is
 * completely different, and the difference is the whole point of detecting it.
 *
 * A `lucid hub --attend` daemon runs DETACHED from any login session, so it
 * cannot read credentials stored in the macOS Keychain - which is where an
 * interactive `claude login` puts them. The turn dies with the harness's raw
 * stderr while the human is, correctly, logged in. Showing that tail verbatim
 * sends them to re-check a login that was never the problem, and no amount of
 * logging in again will fix it: the hub needs env-based auth
 * (`claude setup-token`, then `CLAUDE_CODE_OAUTH_TOKEN` in its environment),
 * which takes precedence over every credential store and works in any process
 * context.
 */
export type AuthFailureKind = "not-logged-in" | "expired" | "invalid-key";

const AUTH_PATTERNS: ReadonlyArray<readonly [RegExp, AuthFailureKind]> = [
  // Claude Code.
  [/oauth session expired|could not be refreshed/i, "expired"],
  [/failed to authenticate/i, "expired"],
  [/not logged in|please run \/login/i, "not-logged-in"],
  [/invalid api key/i, "invalid-key"],
  // Codex.
  [/run codex login/i, "not-logged-in"],
  [/401 unauthorized/i, "expired"],
];

/**
 * Which auth wall the harness's output reports, or null when nothing in it
 * looks like one. Scanned bottom-up like the usage detector: the error is
 * virtually always the last thing a dying turn printed.
 *
 * Returns the KIND, never the line - same reason, same discipline (D-005).
 * The dialog shows the harness's own words through the `tail` it already
 * carries; a record gets the identifier.
 */
export const detectAuthFailure = (output: string): AuthFailureKind | null => {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    for (const [pattern, kind] of AUTH_PATTERNS) {
      if (pattern.test(line)) return kind;
    }
  }
  return null;
};
